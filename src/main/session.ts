// The relay (#69): the DCS-BIOS stream, and the one on/off. Orchestrates a live source —
// transport -> protocol parser -> decoder -> stats — batching pushes to the renderer.
// Source-agnostic across Bridge (DCS <-> device), Monitor (LAN, read-only) and Replay (recorded
// capture); recording can tap any live mode.
//
// The device link is not started or stopped here. It is up whenever the board is plugged in
// (device-link.ts); a source mode only chooses where the stream comes from and whether it
// reaches the device.
import { DcsBiosProtocol } from '@shared/dcsbios'
import {
  DEFAULT_CONFIG,
  isLinkUp,
  type AppConfig,
  type DeviceStatus,
  type LogRow,
  type PushChannel,
  type PushChannels,
  type RelayResult,
  type RelayStatus,
  type RelayState
} from '@shared/ipc'
import { createTransport, type Transport } from './net'
import { debugLog } from './debug'
import { DeviceLink } from './device-link'
import { Recorder, ReplaySource, type ReplayInfo } from './replay'
import { Decoder } from './decode'
import { Stats } from './stats'

type Emit = <C extends PushChannel>(channel: C, payload: PushChannels[C]) => void

const LOG_FLUSH_MS = 33
const TELEMETRY_MS = 200
const STATS_MS = 1000
const MAX_BATCH = 250

type ForwardConfig = Pick<AppConfig, 'sourceMode' | 'replayDriveSerial'>

/**
 * Whether the export stream is written to the SimGateway — and so whether Start needs the board.
 *
 * Bridge always; Replay only with "Drive SimGateway"; Monitor never. Monitor has to say so
 * explicitly now that the port is open in every mode — before #69 it was read-only only because
 * it had no port to write to.
 */
export function exportToDevice(cfg: ForwardConfig): boolean {
  return cfg.sourceMode === 'bridge' || (cfg.sourceMode === 'replay' && cfg.replayDriveSerial)
}

/** Whether device traffic goes on to DCS: only a running Bridge relay has a DCS to send it to. */
export function deviceToDcs(cfg: ForwardConfig, running: boolean): boolean {
  return running && cfg.sourceMode === 'bridge'
}

/** Settings a running relay is built from. Changing anything else must not restart it. */
const RELAY_KEYS = [
  'sourceMode',
  'transport',
  'host',
  'commandPort',
  'listenPort',
  'replayDriveSerial'
] as const satisfies readonly (keyof AppConfig)[]

export function relayConfigChanged(prev: AppConfig, next: AppConfig): boolean {
  return RELAY_KEYS.some((k) => prev[k] !== next[k])
}

export class Session {
  /** The device link: serial, calibration, HID and nodes. Up independently of the relay. */
  readonly link: DeviceLink
  private config: AppConfig = { ...DEFAULT_CONFIG }
  private transport?: Transport
  private replay?: ReplaySource
  private recorder?: Recorder
  private recordPath?: string
  private readonly parser: DcsBiosProtocol
  private decoder = new Decoder()
  private readonly stats = new Stats()
  private logBuf: LogRow[] = []
  private running = false
  private relay: RelayState = { running: false }
  private lastErrKey = ''
  private logTimer?: ReturnType<typeof setInterval>
  private timers: ReturnType<typeof setInterval>[] = []

  constructor(private readonly emit: Emit) {
    this.parser = new DcsBiosProtocol((addr, val) => this.onWrite(addr, val))
    this.link = new DeviceLink(emit)
    this.link.onBytes((bytes) => this.fromDevice(bytes))
    this.link.onLine((l) => {
      if (l.kind !== 'command') return
      // Logged relaying or not: watching panel commands with no DCS is how a panel gets tested.
      this.stats.command(l.line)
      this.logBuf.push({ t: l.t, dir: 'out', address: 0, name: l.identifier, value: l.arg })
    })
    this.link.onError((tag, message) => {
      this.stats.error()
      this.logError(tag, message)
    })
    this.link.onStatus((s) => {
      if (s.state === 'reconnecting') this.stats.reconnect()
    })
  }

  /** App launch: bring up the device link and the log, independent of any relay. */
  open(): void {
    if (this.logTimer) return
    this.logTimer = setInterval(() => this.flushLog(), LOG_FLUSH_MS)
    this.link.start(this.config.autoConnect)
  }

  /** App quit. */
  shutdown(): void {
    this.stop()
    this.link.shutdown()
    if (this.logTimer) clearInterval(this.logTimer)
    this.logTimer = undefined
  }

  getConfig(): AppConfig {
    return this.config
  }

  setConfig(patch: Partial<AppConfig>): AppConfig {
    const prev = this.config
    this.config = { ...prev, ...patch }
    if (prev.autoConnect !== this.config.autoConnect) {
      this.link.setAutoConnect(this.config.autoConnect)
    }
    if (this.running && relayConfigChanged(prev, this.config)) {
      // A rebuild of a relay already running, not a new Start: it is not gated on the device,
      // or editing a setting during a drop would end a relay that only Stop may end.
      this.stop()
      this.run()
    }
    return this.config
  }

  /**
   * Start relaying. Attaches the stream to the device link; never opens or closes the port.
   *
   * Refused while a mode that delivers to the board has no board to deliver to: nothing can be
   * relayed before the link is up. Once running, a drop does not end the relay — it waits, and
   * resumes when the link returns.
   */
  start(): RelayResult {
    if (exportToDevice(this.config) && !isLinkUp(this.link.deviceStatus().state)) {
      return { ok: false, error: 'SimGateway is not connected' }
    }
    return this.run()
  }

  private run(): RelayResult {
    if (this.running) this.stop()
    this.decoder = new Decoder()
    this.parser.reset()
    this.stats.reset()
    this.lastErrKey = ''
    const mode = this.config.sourceMode

    try {
      if (mode === 'replay') {
        const replay = this.replay
        if (!replay) return { ok: false, error: 'No capture loaded' }
        this.running = true
        this.setRelay({ running: true, stream: 'connected' })
        replay.play(
          (chunk) => this.onExport(chunk), // optionally drives the real cockpit from the capture
          () => this.setRelay({ running: true, stream: 'ended' })
        )
      } else {
        const t = createTransport(this.config)
        this.transport = t
        t.onExport((chunk) => this.onExport(chunk))
        t.onError((err) => {
          if (this.transport !== t) return
          this.stats.error()
          this.logError('DCS', err.message)
          this.setRelay({ running: true, stream: 'error', detail: err.message })
        })
        t.onConnected((connected) => {
          if (this.transport !== t) return // a transport being stopped reports its own close
          if (connected) {
            this.setRelay({ running: true, stream: 'connected' })
          } else {
            this.stats.reconnect()
            this.setRelay({ running: true, stream: 'reconnecting' })
          }
        })
        this.running = true
        this.setRelay({ running: true, stream: 'connecting' })
        t.start()
      }

      this.timers = [
        setInterval(() => this.flushTelemetry(), TELEMETRY_MS),
        setInterval(() => this.emit('stats:tick', this.stats.snapshot()), STATS_MS)
      ]
      return { ok: true }
    } catch (err) {
      this.stop()
      return { ok: false, error: (err as Error).message }
    }
  }

  /** Stop relaying. The device link — HID, calibration, nodes — stays up. */
  stop(): RelayResult {
    this.running = false
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.replay?.stop()
    const t = this.transport
    this.transport = undefined // first, so its closing callbacks are recognised as stale
    t?.stop()
    this.flushLog()
    this.setRelay({ running: false })
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

  /** One chunk of the DCS-BIOS export, from DCS or a capture. */
  private onExport(chunk: Buffer): void {
    this.stats.addIn(chunk.length)
    this.parser.processBuffer(chunk)
    this.recorder?.record('in', chunk)
    // Forward byte-for-byte to the SimGateway — unless a calibration exchange is in flight.
    // Parsing for our own UI continues; only the forward pauses.
    if (exportToDevice(this.config) && !this.link.exportGated) this.link.write(chunk)
  }

  /** Device traffic, calibration frames already removed by the link: relay to DCS:7778. */
  private fromDevice(bytes: Buffer): void {
    if (!deviceToDcs(this.config, this.running)) return
    this.transport?.send(bytes)
    this.stats.addOut(bytes.length)
    this.recorder?.record('out', bytes)
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

  private setRelay(relay: RelayState): void {
    this.relay = relay
    this.emit('relay:state', relay)
  }

  /** Snapshot so a (re)loaded renderer can rehydrate the relay and link state. */
  status(): RelayStatus {
    const device: DeviceStatus = this.link.deviceStatus()
    return { running: this.running, relay: this.relay, device, cal: this.link.calSnapshot() }
  }

  /** Push a client diagnostic into the in-app log + the debug log file. */
  private logError(tag: string, msg: string): void {
    debugLog(`error.${tag}`, msg) // always reaches debug.log when debug mode is on
    const key = `${tag}|${msg}`
    if (key === this.lastErrKey) return // dedupe the in-app log only
    this.lastErrKey = key
    this.logBuf.push({ t: Date.now(), dir: 'sys', address: 0, name: tag, value: msg })
  }
}
