// Orchestrates a live DCS-BIOS source: transport -> protocol parser -> decoder
// -> stats, batching pushes to the renderer. Source-agnostic; Monitor mode in
// M3, Bridge (serial) and Replay layer onto the same pipeline later.
import { DcsBiosProtocol } from '@shared/dcsbios'
import {
  DEFAULT_CONFIG,
  type AppConfig,
  type DeviceStatus,
  type LogRow,
  type PushChannel,
  type PushChannels,
  type RelayResult
} from '@shared/ipc'
import { createTransport, type Transport } from './net'
import { Decoder } from './decode'
import { Stats } from './stats'

type Emit = <C extends PushChannel>(channel: C, payload: PushChannels[C]) => void

const LOG_FLUSH_MS = 33
const TELEMETRY_MS = 200
const STATS_MS = 1000
const MAX_BATCH = 250

export class Session {
  private config: AppConfig = { ...DEFAULT_CONFIG }
  private transport?: Transport
  private readonly parser: DcsBiosProtocol
  private decoder = new Decoder()
  private readonly stats = new Stats()
  private logBuf: LogRow[] = []
  private running = false
  private timers: ReturnType<typeof setInterval>[] = []

  constructor(private readonly emit: Emit) {
    this.parser = new DcsBiosProtocol((addr, val) => this.onWrite(addr, val))
  }

  getConfig(): AppConfig {
    return this.config
  }

  setConfig(patch: Partial<AppConfig>): AppConfig {
    this.config = { ...this.config, ...patch }
    if (this.running) {
      this.stop()
      this.start()
    }
    return this.config
  }

  start(): RelayResult {
    if (this.running) this.stop()
    this.decoder = new Decoder()
    this.parser.reset()
    this.stats.reset()
    this.logBuf = []

    try {
      const t = createTransport(this.config)
      this.transport = t
      t.onExport((chunk) => {
        this.stats.addIn(chunk.length)
        this.parser.processBuffer(chunk)
      })
      t.onError((err) => {
        this.stats.error()
        this.setDevice({ state: 'error', detail: err.message })
      })
      t.onConnected((connected) => {
        if (connected) {
          this.setDevice({ state: this.config.sourceMode === 'bridge' ? 'relaying' : 'connected' })
        } else {
          this.stats.reconnect()
          this.setDevice({ state: 'reconnecting' })
        }
      })
      this.setDevice({ state: 'scanning' })
      t.start()
      this.running = true
      this.timers = [
        setInterval(() => this.flushLog(), LOG_FLUSH_MS),
        setInterval(() => this.flushTelemetry(), TELEMETRY_MS),
        setInterval(() => this.emit('stats:tick', this.stats.snapshot()), STATS_MS)
      ]
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  stop(): RelayResult {
    this.running = false
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.transport?.stop()
    this.transport = undefined
    this.flushLog()
    this.setDevice({ state: 'no-device' })
    return { ok: true }
  }

  /** Send a DCS-BIOS command toward DCS (used by Bridge/Replay; no-op in pure Monitor). */
  sendCommand(line: string): void {
    const buf = Buffer.from(line, 'ascii')
    this.transport?.send(buf)
    this.stats.addOut(buf.length)
    this.stats.command(line.trim())
  }

  private onWrite(address: number, value: number): void {
    const rows = this.decoder.handle(address, value, Date.now())
    if (rows.length) {
      this.stats.addFrames(rows.length)
      for (const r of rows) this.logBuf.push(r)
    }
  }

  private flushLog(): void {
    if (this.logBuf.length === 0) return
    const batch = this.logBuf.splice(0, MAX_BATCH)
    this.emit('log:batch', batch)
  }

  private flushTelemetry(): void {
    this.emit('telemetry:tick', this.decoder.telemetrySnapshot())
    const ac = this.decoder.aircraft()
    if (ac) this.emit('aircraft:changed', ac)
  }

  private setDevice(status: DeviceStatus): void {
    this.emit('device:status', status)
  }
}
