// Orchestrates a live DCS-BIOS source: transport -> protocol parser -> decoder
// -> stats, batching pushes to the renderer. Source-agnostic across Monitor
// (network), Bridge (serial), and Replay (recorded capture); recording can tap
// any live mode.
import { DcsBiosProtocol, LineAssembler, parseCommand } from '@shared/dcsbios'
import { NODE_END_MSG, NODE_MSG, NodeRoster, nodeRosterRequest } from '@shared/nodes'
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
import { debugLog } from './debug'
import { HidReader } from './hid'
import { Recorder, ReplaySource, type ReplayInfo } from './replay'
import { Decoder } from './decode'
import { Stats } from './stats'

type Emit = <C extends PushChannel>(channel: C, payload: PushChannels[C]) => void

const LOG_FLUSH_MS = 33
const TELEMETRY_MS = 200
const STATS_MS = 1000
const NODES_REFRESH_MS = 5000
const MAX_BATCH = 250

export class Session {
  private config: AppConfig = { ...DEFAULT_CONFIG }
  private transport?: Transport
  private serial?: SerialBridge
  private hid?: HidReader
  private replay?: ReplaySource
  private recorder?: Recorder
  private recordPath?: string
  private readonly roster = new NodeRoster()
  private cmdAssembler = new LineAssembler()
  private readonly parser: DcsBiosProtocol
  private decoder = new Decoder()
  private readonly stats = new Stats()
  private logBuf: LogRow[] = []
  private running = false
  private lastDevice: DeviceStatus = { state: 'no-device' }
  private lastErrKey = ''
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
    this.roster.reset()
    this.cmdAssembler = new LineAssembler()
    this.logBuf = []
    this.lastErrKey = ''
    const mode = this.config.sourceMode

    try {
      if (mode === 'replay') {
        if (!this.replay) return { ok: false, error: 'No capture loaded' }
        if (this.config.replayDriveSerial) this.startSerialWriter()
        this.setDevice({ state: 'connected' })
        this.replay.play(
          (chunk) => {
            this.ingestExport(chunk)
            this.serial?.write(chunk) // optionally drive the real cockpit from the capture
          },
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
          this.logError('DCS', err.message)
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
      // Bridge: poll the node roster so silent deaths get reconciled.
      if (mode === 'bridge') {
        this.timers.push(setInterval(() => this.requestNodes(), NODES_REFRESH_MS))
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  /** Serial-only output for Replay mode: write the replayed export to the SimGateway. */
  private startSerialWriter(): void {
    const s = new SerialBridge(this.config.autoReconnect)
    this.serial = s
    s.onData(() => {}) // panel commands have nowhere to go with no DCS
    s.onError(() => {}) // replay keeps feeding the UI regardless
    s.onOpen((path) =>
      this.setDevice({
        state: 'relaying',
        portPath: path,
        vid: SIMGATEWAY_VID,
        pid: SIMGATEWAY_PID
      })
    )
    s.start()
  }

  private startBridgeDevices(): void {
    const s = new SerialBridge(this.config.autoReconnect)
    this.serial = s
    s.onData((chunk) => this.onSerialData(chunk))
    s.onOpen((path) => {
      this.setDevice({
        state: 'relaying',
        portPath: path,
        vid: SIMGATEWAY_VID,
        pid: SIMGATEWAY_PID
      })
      this.requestNodes() // seed the roster as soon as the device is up
    })
    s.onClose(() => {
      this.stats.reconnect()
      this.setDevice({ state: 'reconnecting' })
    })
    s.onError((err) => {
      this.stats.error()
      this.logError('SERIAL', err.message)
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

  /** Ask PanelBridge for the full node roster (inject the request export to the serial). */
  requestNodes(): void {
    if (!this.serial) return
    this.roster.beginBurst() // isolate the reply burst so prior deltas don't block pruning
    this.serial.write(Buffer.from(nodeRosterRequest()))
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
      // Node-status messages are tapped to the roster, not logged as panel commands.
      if (identifier === NODE_MSG || identifier === NODE_END_MSG) {
        debugLog('node', `${identifier} ${arg}`.trim())
        this.roster.applyMessage(identifier, arg)
        continue
      }
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
    if (this.roster.takeDirty()) this.emit('nodes:status', this.roster.snapshot())
  }

  private setDevice(status: DeviceStatus): void {
    this.lastDevice = status
    this.emit('device:status', status)
  }

  /** Snapshot so a (re)loaded renderer can rehydrate the running/relay state. */
  status(): { running: boolean; device: DeviceStatus } {
    return { running: this.running, device: this.lastDevice }
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
