// Orchestrates a live DCS-BIOS source: transport -> protocol parser -> decoder
// -> stats, batching pushes to the renderer. Source-agnostic across Monitor
// (network), Bridge (serial), and Replay (recorded capture); recording can tap
// any live mode.
import { DcsBiosProtocol, LineAssembler, parseCommand } from '@shared/dcsbios'
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
import { SerialBridge, SIMGATEWAY_PID, SIMGATEWAY_VID } from './serial'
import { HidReader } from './hid'
import { Recorder, ReplaySource, type ReplayInfo } from './replay'
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
  private serial?: SerialBridge
  private hid?: HidReader
  private replay?: ReplaySource
  private recorder?: Recorder
  private recordPath?: string
  private cmdAssembler = new LineAssembler()
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
    this.cmdAssembler = new LineAssembler()
    this.logBuf = []
    const mode = this.config.sourceMode

    try {
      if (mode === 'replay') {
        if (!this.replay) return { ok: false, error: 'No capture loaded' }
        this.setDevice({ state: 'connected' })
        this.replay.play(
          (chunk) => this.ingestExport(chunk),
          () => this.setDevice({ state: 'no-device' })
        )
      } else {
        const bridge = mode === 'bridge'
        const t = createTransport(this.config)
        this.transport = t
        t.onExport((chunk) => {
          this.ingestExport(chunk)
          this.serial?.write(chunk) // Bridge: forward export byte-for-byte to the SimGateway
        })
        t.onError((err) => {
          this.stats.error()
          if (!bridge) this.setDevice({ state: 'error', detail: err.message })
        })
        t.onConnected((connected) => {
          if (bridge) return // serial drives the headline device status in Bridge mode
          if (connected) {
            this.setDevice({ state: 'connected' })
          } else {
            this.stats.reconnect()
            this.setDevice({ state: 'reconnecting' })
          }
        })

        if (bridge) this.startBridgeDevices()

        this.setDevice({ state: 'scanning' })
        t.start()
      }

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

  private startBridgeDevices(): void {
    const s = new SerialBridge(this.config.autoReconnect)
    this.serial = s
    s.onData((chunk) => this.onSerialData(chunk))
    s.onOpen((path) =>
      this.setDevice({
        state: 'relaying',
        portPath: path,
        vid: SIMGATEWAY_VID,
        pid: SIMGATEWAY_PID
      })
    )
    s.onClose(() => {
      this.stats.reconnect()
      this.setDevice({ state: 'reconnecting' })
    })
    s.onError((err) => {
      this.stats.error()
      this.setDevice({ state: 'error', detail: err.message })
    })
    s.start()

    // HID runs in parallel with the serial CDC; errors just leave it idle.
    const h = new HidReader()
    this.hid = h
    h.onError(() => {})
    h.start()
  }

  stop(): RelayResult {
    this.running = false
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.replay?.stop()
    this.hid?.stop()
    this.hid = undefined
    this.serial?.stop()
    this.serial = undefined
    this.transport?.stop()
    this.transport = undefined
    this.flushLog()
    this.setDevice({ state: 'no-device' })
    return { ok: true }
  }

  // ── record / replay control ────────────────────────────────────────────────

  startRecording(path: string): void {
    this.recorder = new Recorder()
    this.recordPath = path
  }

  stopRecording(): { path?: string; events: number } {
    const events = this.recorder?.count ?? 0
    if (this.recorder && this.recordPath) this.recorder.save(this.recordPath)
    const path = this.recordPath
    this.recorder = undefined
    this.recordPath = undefined
    return { path, events }
  }

  isRecording(): boolean {
    return !!this.recorder
  }

  loadReplay(path: string): ReplayInfo {
    this.replay?.stop()
    this.replay = ReplaySource.load(path)
    return this.replay.info()
  }

  // ── pipeline ───────────────────────────────────────────────────────────────

  private ingestExport(chunk: Buffer): void {
    this.stats.addIn(chunk.length)
    this.parser.processBuffer(chunk)
    this.recorder?.record('in', chunk)
  }

  /** Panel commands arriving from the SimGateway serial: relay to DCS, log, count. */
  private onSerialData(chunk: Buffer): void {
    this.transport?.send(chunk) // byte-for-byte relay to DCS:7778
    this.stats.addOut(chunk.length)
    this.recorder?.record('out', chunk)
    const t = Date.now()
    for (const line of this.cmdAssembler.push(chunk)) {
      if (!line.trim()) continue
      const { identifier, arg } = parseCommand(line)
      this.stats.command(line.trim())
      this.logBuf.push({ t, dir: 'out', address: 0, name: identifier, value: arg })
    }
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
    if (this.hid) this.emit('hid:report', this.hid.snapshot())
  }

  private setDevice(status: DeviceStatus): void {
    this.emit('device:status', status)
  }
}
