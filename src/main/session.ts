// Orchestrates a live DCS-BIOS source: transport -> protocol parser -> decoder
// -> stats, batching pushes to the renderer. Source-agnostic across Monitor
// (network), Bridge (serial), and Replay (recorded capture); recording can tap
// any live mode.
import { DcsBiosProtocol, LineAssembler, parseCommand } from '@shared/dcsbios'
import { NODE_END_MSG, NODE_MSG, NodeRoster, nodeRosterRequest } from '@shared/nodes'
import {
  DEFAULT_CONFIG,
  type AppConfig,
  type CalCommitAxis,
  type CalHello,
  type CalRawSample,
  type CalResult,
  type CalSnapshot,
  type DeviceStatus,
  type LogRow,
  type PushChannel,
  type PushChannels,
  type RelayResult,
  type SerialFrame
} from '@shared/ipc'
import { createTransport, type Transport } from './net'
import { CalLink, CalNackError, CalTimeoutError } from './callink'
import {
  findSimGatewayPort,
  listSerialPorts,
  SerialBridge,
  SIMGATEWAY_PID,
  SIMGATEWAY_VID
} from './serial'
import { CAL_NACK } from '@shared/calibration'
import { debugLog } from './debug'
import { HidReader } from './hid'
import { Recorder, ReplaySource, type ReplayInfo } from './replay'
import { NODE_NAMES } from './reference/node-names.generated'
import { NODE_FAULT_CODES } from './reference/node-status.generated'
import { Decoder } from './decode'
import { Stats } from './stats'

type Emit = <C extends PushChannel>(channel: C, payload: PushChannels[C]) => void

const LOG_FLUSH_MS = 33
const TELEMETRY_MS = 200
const STATS_MS = 1000
const NODES_REFRESH_MS = 5000
const SERIAL_FLUSH_MS = 50
const MAX_BATCH = 250
const MAX_SERIAL_BUF = 4000

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
  private serialMonitor = false
  private serialBuf: SerialFrame[] = []
  private cal?: CalLink
  private calRawBuf: CalRawSample[] = []
  private calSerialNumber?: string
  /**
   * Last snapshot the device confirmed, held so a renderer reload can rehydrate.
   *
   * Cleared whenever the link goes down, which is what stops it describing a board that is no
   * longer attached — or, worse, a different one after a reconnect.
   */
  private lastCal?: CalSnapshot
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
          // Bridge: forward export byte-for-byte to the SimGateway — unless a calibration
          // exchange is in flight. The protocol's one rule is that the client stops relaying
          // the export stream before ANY exchange, a 10 ms HELLO as much as a whole session:
          // it frees the link and removes any chance of the gateway reading export binary as
          // a calibration frame. Parsing for our own UI continues; only the forward pauses.
          if (!this.cal?.exportGated) this.serial?.write(chunk)
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
        setInterval(() => this.flushSerial(), SERIAL_FLUSH_MS),
        setInterval(() => this.flushCalRaw(), SERIAL_FLUSH_MS),
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
    s.onMonitor((dir, chunk) => this.onSerialTraffic(dir, chunk))
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
    // The calibration channel shares this port. It runs whenever the port is open, not only
    // during a session: HELLO and GET_CAL are answered outside one, so there is no point at
    // which it is safe to stop watching for frames.
    this.cal = new CalLink(
      (data) => s.write(data),
      (sample) => this.calRawBuf.push({ t: Date.now(), ...sample })
    )
    s.onData((chunk) => this.onSerialData(chunk))
    s.onMonitor((dir, chunk) => this.onSerialTraffic(dir, chunk))
    s.onOpen((path) => {
      this.setDevice({
        state: 'relaying',
        portPath: path,
        vid: SIMGATEWAY_VID,
        pid: SIMGATEWAY_PID
      })
      this.requestNodes() // seed the roster as soon as the device is up
      void this.readCalibrationState() // badges, with no dialog open
    })
    s.onClose(() => {
      // Fail anything in flight and release held bytes: a reconnect must not resume
      // mid-candidate, and an awaiting caller would otherwise hang on a reply that cannot come.
      // The released bytes are a candidate that never completed — not a frame, therefore DCS
      // traffic — so they go on down the relay rather than being dropped here.
      const held = this.cal?.close()
      if (held?.length) this.relayFromDevice(held)
      this.lastCal = undefined // the board it described may not be the one that comes back
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
    this.cal?.close()
    this.cal = undefined
    this.calRawBuf = []
    this.lastCal = undefined
    this.calSerialNumber = undefined
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

  /** Toggle the raw serial monitor (gated to avoid streaming the export at full rate). */
  setSerialMonitor(on: boolean): void {
    this.serialMonitor = on
    if (!on) this.serialBuf = []
  }

  private onSerialTraffic(dir: 'tx' | 'rx', chunk: Buffer): void {
    if (!this.serialMonitor) return
    this.serialBuf.push({ t: Date.now(), dir, hex: chunk.toString('hex') })
    if (this.serialBuf.length > MAX_SERIAL_BUF) {
      this.serialBuf.splice(0, this.serialBuf.length - MAX_SERIAL_BUF)
    }
  }

  private flushSerial(): void {
    if (this.serialBuf.length === 0) return
    this.emit('serial:traffic', this.serialBuf.splice(0, MAX_SERIAL_BUF))
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
    // De-multiplex BEFORE anything else sees the chunk. Two reasons, and the first is the one
    // that bites: this path relays to DCS's command socket, and during a session RAW arrives at
    // up to ~250 frames/s — that binary has no business reaching DCS. Second, the gateway
    // injects frames at arbitrary byte boundaries, so one can land mid-line; removing its bytes
    // is exactly what rejoins the interrupted line for the assembler below.
    this.relayFromDevice(this.cal ? this.cal.ingest(chunk) : chunk)
  }

  /**
   * Everything downstream of the de-mux: relay to DCS, count, record, assemble lines.
   *
   * Split out because it has a second caller. On port close the de-mux flushes any incomplete
   * candidate it was holding, and those bytes were never a frame — they belong to the DCS
   * stream. Dropping them would breach the byte-preservation guarantee the whole de-mux design
   * rests on. They must not be fed back through the de-mux, which is why this starts below it.
   */
  private relayFromDevice(rest: Buffer): void {
    if (rest.length === 0) return

    this.transport?.send(rest) // byte-for-byte relay to DCS:7778
    this.stats.addOut(rest.length)
    this.recorder?.record('out', rest)
    const t = Date.now()
    for (const line of this.cmdAssembler.push(rest)) {
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
    if (this.roster.takeDirty()) {
      const nodes = this.roster.snapshot().map((n) => {
        const fc = n.faultId ? NODE_FAULT_CODES[n.faultId] : undefined
        return {
          ...n,
          name: NODE_NAMES[n.nodeId]?.name,
          faultAbbr: fc?.abbr,
          faultLabel: fc?.label,
          faultDesc: fc?.description
        }
      })
      this.emit('nodes:status', nodes)
    }
  }

  // ── axis calibration (#46) ─────────────────────────────────────────────────

  /**
   * Read-only: ask the gateway what it is and what calibration it holds, once per port open.
   *
   * Writes nothing. It exists so the HID tab can show per-axis calibrated/uncalibrated badges
   * and an uncalibrated count **without anyone opening the dialog** — which is precisely why
   * the firmware answers HELLO and GET_CAL outside a session. Everything that changes stored
   * calibration is scoped to an open dialog.
   *
   * Also captures the board's USB serial, the key part of the restore cache in #46.
   *
   * Failure is not an error state: a gateway on older firmware simply never answers, and the
   * relay is unaffected either way.
   */
  private async readCalibrationState(): Promise<void> {
    this.calSerialNumber = await this.gatewaySerialNumber()
    const hello = await this.calHello()
    if (!hello.ok) {
      debugLog('cal.absent', `no calibration channel: ${hello.message}`)
      return
    }
    const { proto, blobVersion, fw } = hello.value
    debugLog('cal.hello', {
      proto,
      blobVersion,
      fw: `${fw.major}.${fw.minor}.${fw.patch}`,
      serial: this.calSerialNumber ?? null
    })
    const read = await this.calRead()
    if (!read.ok) {
      debugLog('cal.absent', `read failed: ${read.message}`)
      return
    }
    // Masks, not endpoints: this is the line a bug report needs — which axes the sketch
    // declares, and which of them the device considers calibrated.
    debugLog('cal.data', {
      present: read.value.presentMask.toString(2).padStart(8, '0'),
      calibrated: read.value.calibratedMask.toString(2).padStart(8, '0')
    })
  }

  /**
   * USB serial of the attached gateway, for keying the restore cache in #46.
   *
   * From SerialPort.list(), not node-hid: node-hid is an optional dependency that may be absent
   * entirely, and HidReader opens by VID/PID without exposing a serial. Confirmed on hardware —
   * the board reports 50031327805E871C. Absent or empty means no restore may be offered, since
   * guessing which board a cached calibration belongs to is the failure the key exists to stop.
   */
  private async gatewaySerialNumber(): Promise<string | undefined> {
    try {
      const path = await findSimGatewayPort()
      if (!path) return undefined
      const ports = await listSerialPorts()
      const hit = ports.find((p) => p.path === path)
      return hit?.serialNumber || undefined
    } catch {
      return undefined
    }
  }

  /** Convert a CalLink rejection into the discriminated result the renderer can branch on. */
  private async calRun<T>(fn: (link: CalLink) => Promise<T>): Promise<CalResult<T>> {
    if (!this.cal) {
      return { ok: false, kind: 'offline', message: 'SimGateway is not connected' }
    }
    try {
      return { ok: true, value: await fn(this.cal) }
    } catch (err) {
      if (err instanceof CalTimeoutError) {
        return { ok: false, kind: 'timeout', message: err.message }
      }
      if (err instanceof CalNackError) {
        const name =
          Object.entries(CAL_NACK).find(([, v]) => v === err.reason)?.[0] ??
          `0x${err.reason.toString(16)}`
        return {
          ok: false,
          kind: 'nack',
          reason: err.reason,
          reasonName: name,
          detail: err.detail,
          message: err.message
        }
      }
      return { ok: false, kind: 'error', message: (err as Error).message }
    }
  }

  calHello(): Promise<CalResult<CalHello>> {
    return this.calRun((l) => l.hello())
  }

  /** Read stored calibration and push it to the renderer, so badges follow the device. */
  async calRead(): Promise<CalResult<CalSnapshot>> {
    const r = await this.calRun((l) => l.getCal())
    if (r.ok) {
      const snap: CalSnapshot = { ...r.value, serialNumber: this.calSerialNumber }
      this.lastCal = snap
      this.emit('cal:data', snap)
      return { ok: true, value: snap }
    }
    return r
  }

  calSessionOpen(axisIdx: number): Promise<CalResult<{ timeoutMs: number; axisIdx: number }>> {
    return this.calRun((l) => l.openSession(axisIdx))
  }

  calStreamSelect(axisIdx: number): Promise<CalResult<null>> {
    return this.calRun(async (l) => {
      await l.streamSelect(axisIdx)
      return null
    })
  }

  /**
   * Write one axis. Resolving means the device acknowledged receipt, not that it stored the
   * values — the caller re-reads with calRead() to learn what is actually on the device.
   */
  calCommit(axis: CalCommitAxis): Promise<CalResult<null>> {
    return this.calRun(async (l) => {
      await l.commit(axis)
      return null
    })
  }

  calReset(idx: number): Promise<CalResult<null>> {
    return this.calRun(async (l) => {
      await l.reset(idx)
      return null
    })
  }

  calSessionClose(): Promise<CalResult<null>> {
    return this.calRun(async (l) => {
      await l.closeSession()
      return null
    })
  }

  private flushCalRaw(): void {
    if (this.calRawBuf.length === 0) return
    this.emit('cal:raw', this.calRawBuf.splice(0, this.calRawBuf.length))
  }

  private setDevice(status: DeviceStatus): void {
    this.lastDevice = status
    this.emit('device:status', status)
  }

  /** Snapshot so a (re)loaded renderer can rehydrate the running/relay state. */
  status(): { running: boolean; device: DeviceStatus; cal?: CalSnapshot } {
    return { running: this.running, device: this.lastDevice, cal: this.lastCal }
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
