// The device link (#69): the SimGateway serial port and everything that rides on it — calibration
// (CalLink), HID, the node roster and the node data layer. Up whenever the board is plugged in, in
// every source mode, relaying or not; down only on unplug or an explicit disconnect.
//
// The relay (session.ts) attaches to it rather than owning it: export goes out through write(),
// and device traffic comes back through onBytes() / onLine(). That split is the point. Bundled
// together, there was no node status, PDU telemetry, HID or calibration unless DCS was being
// relayed, and stopping the relay tore the port down with it.
import { LineAssembler, parseCommand } from '@shared/dcsbios'
import { NODE_END_MSG, NODE_MSG, NodeRoster, nodeRosterRequest } from '@shared/nodes'
import { NODE_TELEM_MSG } from '@shared/node-telem'
import type { LogEventInput } from '@shared/events'
import {
  isLinkUp,
  type CalCacheEntry,
  type CalCommitAxis,
  type CalHello,
  type CalRawSample,
  type CalResult,
  type CalSnapshot,
  type DeviceStatus,
  type PushChannel,
  type PushChannels,
  type SerialFrame
} from '@shared/ipc'
import { CAL_NACK, CAL_AXIS_NONE } from '@shared/calibration'
import {
  boardFor,
  dropAxis,
  regressedAxes,
  storeAxes,
  type CachedAxis,
  type CachedBoard
} from '@shared/cal-cache'
import { CalLink, CalNackError, CalTimeoutError } from './callink'
import {
  findSimGatewayPort,
  listSerialPorts,
  PortNotFoundError,
  SerialBridge,
  SIMGATEWAY_PID,
  SIMGATEWAY_VID
} from './serial'
import { debugLog } from './debug'
import { HidReader } from './hid'
import { loadCalCache, saveCalCache } from './cal-cache'
import { NODE_NAMES } from './reference/node-names.generated'
import { NODE_FAULT_CODES } from './reference/node-status.generated'
import { NodeHub } from './node-hub'

type Emit = <C extends PushChannel>(channel: C, payload: PushChannels[C]) => void

/** Node status, node model and the HID snapshot. Same cadence the relay used for them. */
const LINK_FLUSH_MS = 200
/**
 * Shortest gap between HID pushes to the renderer.
 *
 * A press used to wait for the 200 ms telemetry tick, which is visible lag on a button and
 * enough to lose a quick tap entirely. Reports now drive the push, capped here at roughly one
 * frame so a fast axis sweep — the device can emit a few hundred a second — cannot flood IPC.
 */
const HID_PUSH_MS = 16
const HID_RATE_MS = 1000
const NODES_REFRESH_MS = 5000
const SERIAL_FLUSH_MS = 50
const MAX_SERIAL_BUF = 4000

/** One complete text line from the device, below the calibration de-mux. */
export interface DeviceLine {
  /** `node` lines are tapped to the roster / node layer; `command` lines are panel commands. */
  kind: 'node' | 'command'
  identifier: string
  arg: string
  line: string
  t: number
}

type Unsubscribe = () => void

function subscribe<T>(set: Set<T>, cb: T): Unsubscribe {
  set.add(cb)
  return () => set.delete(cb)
}

export class DeviceLink {
  readonly roster = new NodeRoster()
  /** Node telemetry, mapping and the combined node model (#61). */
  readonly nodes: NodeHub
  private serial?: SerialBridge
  private hid?: HidReader
  private hidPushedAt = 0
  private hidPushTimer?: ReturnType<typeof setTimeout>
  private assembler = new LineAssembler()
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
  private status: DeviceStatus = { state: 'disconnected' }
  private autoConnect = true
  private started = false
  private timers: ReturnType<typeof setInterval>[] = []

  private readonly bytesCbs = new Set<(bytes: Buffer) => void>()
  private readonly lineCbs = new Set<(line: DeviceLine) => void>()
  private readonly statusCbs = new Set<(status: DeviceStatus) => void>()
  private readonly errorCbs = new Set<(tag: string, message: string) => void>()
  private readonly eventCbs = new Set<(events: LogEventInput[]) => void>()

  constructor(private readonly emit: Emit) {
    this.nodes = new NodeHub(emit, this.roster, (events) => {
      for (const cb of this.eventCbs) cb(events)
    })
  }

  // ── events ─────────────────────────────────────────────────────────────────

  /**
   * Device traffic with calibration frames removed — the DCS-BIOS command stream, byte for byte.
   * Fired whether or not anything relays it; forwarding is the relay's decision.
   */
  onBytes(cb: (bytes: Buffer) => void): Unsubscribe {
    return subscribe(this.bytesCbs, cb)
  }

  /** Every complete text line, after the link's own node taps have seen it. */
  onLine(cb: (line: DeviceLine) => void): Unsubscribe {
    return subscribe(this.lineCbs, cb)
  }

  /** Each change of link state, also pushed to the renderer as `device:status`. */
  onStatus(cb: (status: DeviceStatus) => void): Unsubscribe {
    return subscribe(this.statusCbs, cb)
  }

  /** Link faults worth showing the user. "No board plugged in" is a state, not one of these. */
  onError(cb: (tag: string, message: string) => void): Unsubscribe {
    return subscribe(this.errorCbs, cb)
  }

  /** Node changes for the event log (#64): online / offline, flags raised and cleared, new nodes. */
  onNodeEvents(cb: (events: LogEventInput[]) => void): Unsubscribe {
    return subscribe(this.eventCbs, cb)
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /** App launch: start the link's timers and, unless the user opted out, the link itself. */
  start(autoConnect: boolean): void {
    if (this.started) return
    this.started = true
    this.autoConnect = autoConnect
    this.timers = [
      setInterval(() => this.flushLink(), LINK_FLUSH_MS),
      setInterval(() => this.flushSerial(), SERIAL_FLUSH_MS),
      setInterval(() => this.flushCalRaw(), SERIAL_FLUSH_MS),
      setInterval(() => this.hid?.sampleRate(), HID_RATE_MS),
      // Poll the node roster so silent deaths get reconciled — relaying or not.
      setInterval(() => this.requestNodes(), NODES_REFRESH_MS)
    ]
    this.startHid()
    if (autoConnect) this.connect()
    else this.setStatus({ state: 'disconnected' })
  }

  /**
   * HID is read, never claimed: DCS reads the same interface as a joystick, so it runs for as long
   * as the app does — independent of the serial port, and still up while the port is released.
   * It reconnects on its own, so its errors are worth recording rather than swallowing — they are
   * how we learn whether an unplug surfaces here at all, or only as the serial port dropping.
   */
  private startHid(): void {
    const h = new HidReader()
    this.hid = h
    h.onError((err) => debugLog('hid.error', { message: err.message }))
    h.onReport(() => this.pushHid())
    h.start()
  }

  /** App quit. */
  shutdown(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.teardown()
    if (this.hidPushTimer) clearTimeout(this.hidPushTimer)
    this.hidPushTimer = undefined
    this.hid?.stop()
    this.hid = undefined
    this.started = false
  }

  /**
   * Turning auto-connect on connects now if the link is down. Turning it off leaves an open link
   * alone — it only stops the client taking the port on its own from here on.
   */
  setAutoConnect(on: boolean): void {
    const was = this.autoConnect
    this.autoConnect = on
    if (this.started && on && !was && !this.serial) this.connect()
  }

  /**
   * Open the port, looking for the board until it appears. A no-op while already open or looking
   * — except after an error, where it is the Retry: start over with a fresh port.
   */
  connect(): void {
    if (this.serial && this.status.state !== 'error') return
    this.teardown()
    // Always retries: "not found" keeps looking whatever the setting, because someone asked for
    // this link. What auto-connect governs is reopening after a drop, handled in onClose.
    const s = new SerialBridge(true)
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
    s.onOpen((path) => this.onOpen(path))
    s.onClose(() => this.onClose())
    s.onError((err) => {
      if (err instanceof PortNotFoundError) {
        // The normal state of an unplugged board. Still looking; not an error.
        this.setStatus({ state: 'no-device' })
        return
      }
      this.raise('SERIAL', err.message)
      this.setStatus({ state: 'error', portPath: s.portPath(), detail: err.message })
    })
    this.setStatus({ state: 'scanning' })
    s.start()
  }

  /**
   * Close the serial port and keep it closed — through a replug — until connect(). HID stays up:
   * releasing the port is for other tools that need the CDC, and the HID interface is shared.
   * Calibration rides on the serial port, so it is unavailable until the link is back.
   */
  disconnect(): void {
    this.teardown()
    this.setStatus({ state: 'disconnected' })
  }

  /** Release the serial port and what rides on it. */
  private teardown(): void {
    // Bytes the de-mux was holding are DCS traffic, but with the link going away deliberately
    // there is no stream left for them to belong to.
    this.cal?.close()
    this.cal = undefined
    this.calRawBuf = []
    this.lastCal = undefined
    this.calSerialNumber = undefined
    this.serial?.stop()
    this.serial = undefined
  }

  private onOpen(path: string): void {
    // A port open may be a different board, or the same one after an outage: node state starts
    // over, together. What survives is persisted (node-mapping.json) — names, adopted and ignored
    // nodes, hidden flags. Not on close: while unplugged the renderer shows the last state, dimmed.
    this.roster.reset()
    this.nodes.reset()
    this.assembler = new LineAssembler() // a line cut by the unplug must not prefix the next one
    this.setStatus({
      state: 'connected',
      portPath: path,
      vid: SIMGATEWAY_VID,
      pid: SIMGATEWAY_PID
    })
    this.requestNodes() // seed the roster as soon as the device is up
    void this.readCalibrationState() // badges, with no dialog open
    // Same physical device, so the port reopening is proof it re-enumerated and any HID handle
    // we hold is stale. This is the reliable trigger: a disconnect does not surface as a
    // node-hid error event on every platform, and serial recovery is proven.
    this.hid?.reopen()
  }

  private onClose(): void {
    // Fail anything in flight and release held bytes: a reconnect must not resume
    // mid-candidate, and an awaiting caller would otherwise hang on a reply that cannot come.
    // The released bytes are a candidate that never completed — not a frame, therefore DCS
    // traffic — so they go on down the relay rather than being dropped here.
    const held = this.cal?.close()
    if (held?.length) this.fromDevice(held)
    this.lastCal = undefined // the board it described may not be the one that comes back
    if (!this.autoConnect) {
      // Opted out of the client taking the port on its own: a drop leaves it down.
      this.disconnect()
      return
    }
    this.setStatus({ state: 'reconnecting' })
  }

  // ── output ─────────────────────────────────────────────────────────────────

  /** Write to the device. A no-op while the port is not open. */
  write(data: Buffer): void {
    this.serial?.write(data)
  }

  /**
   * A calibration exchange is in flight, and the export stream must not be forwarded.
   *
   * The protocol's one rule is that the client stops relaying the export stream before ANY
   * exchange, a 10 ms HELLO as much as a whole session: it frees the link and removes any chance
   * of the gateway reading export binary as a calibration frame.
   */
  get exportGated(): boolean {
    return !!this.cal?.exportGated
  }

  /** Ask PanelBridge for the full node roster (inject the request export to the serial). */
  requestNodes(): void {
    if (!this.serial || !isLinkUp(this.status.state)) return
    this.roster.beginBurst() // isolate the reply burst so prior deltas don't block pruning
    this.serial.write(Buffer.from(nodeRosterRequest()))
  }

  deviceStatus(): DeviceStatus {
    return this.status
  }

  calSnapshot(): CalSnapshot | undefined {
    return this.lastCal
  }

  // ── input ──────────────────────────────────────────────────────────────────

  private onSerialData(chunk: Buffer): void {
    // De-multiplex BEFORE anything else sees the chunk. Two reasons, and the first is the one
    // that bites: the relay sends this on to DCS's command socket, and during a session RAW
    // arrives at up to ~250 frames/s — that binary has no business reaching DCS. Second, the
    // gateway injects frames at arbitrary byte boundaries, so one can land mid-line; removing its
    // bytes is exactly what rejoins the interrupted line for the assembler below.
    this.fromDevice(this.cal ? this.cal.ingest(chunk) : chunk)
  }

  /**
   * Everything downstream of the de-mux: hand the bytes to the relay, assemble and tap lines.
   *
   * Split out because it has a second caller. On port close the de-mux flushes any incomplete
   * candidate it was holding, and those bytes were never a frame — they belong to the DCS
   * stream. Dropping them would breach the byte-preservation guarantee the whole de-mux design
   * rests on. They must not be fed back through the de-mux, which is why this starts below it.
   */
  private fromDevice(rest: Buffer): void {
    if (rest.length === 0) return
    for (const cb of this.bytesCbs) cb(rest)
    const t = Date.now()
    for (const line of this.assembler.push(rest)) {
      if (!line.trim()) continue
      const { identifier, arg } = parseCommand(line)
      let kind: DeviceLine['kind'] = 'command'
      // Node-status messages are tapped to the roster, not logged as panel commands.
      if (identifier === NODE_MSG || identifier === NODE_END_MSG) {
        debugLog('node', `${identifier} ${arg}`.trim())
        this.roster.applyMessage(identifier, arg, t)
        this.nodes.statusLine(identifier, line.trim(), t)
        kind = 'node'
      } else if (identifier === NODE_TELEM_MSG) {
        // Node telemetry (~1/s per PDU) likewise: tapped, never logged as a panel command.
        this.nodes.telemetry(arg, t, line.trim())
        kind = 'node'
      }
      for (const cb of this.lineCbs) cb({ kind, identifier, arg, line: line.trim(), t })
    }
  }

  // ── renderer pushes ────────────────────────────────────────────────────────

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

  /**
   * Node and HID pushes, relaying or not.
   *
   * Node pushes stop while the link is down, deliberately with no reset and no empty model: the
   * renderer keeps the last state and dims it from `device:status`. A stale-telemetry transition
   * computed during an unplug would only repeat what the link state already says.
   */
  private flushLink(): void {
    // Still emitted while nothing is arriving: a silent device is the normal resting state, and
    // ageMs and the rate have to keep moving for the UI to say so.
    if (this.hid) this.emit('hid:report', this.hid.snapshot())
    if (!isLinkUp(this.status.state)) return
    const rosterChanged = this.roster.takeDirty()
    if (rosterChanged) {
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
    this.nodes.flush(rosterChanged)
  }

  /**
   * Push HID state, at most once per `HID_PUSH_MS`.
   *
   * Leading edge so a press shows immediately, trailing edge so the state that follows it is
   * never the one left unsent — which is what stops a press-and-release inside one window from
   * disappearing. Both halves are needed: leading alone loses the release, trailing alone adds
   * the delay back.
   */
  private pushHid(): void {
    if (!this.hid) return
    const now = Date.now()
    const since = now - this.hidPushedAt
    if (since >= HID_PUSH_MS) {
      this.hidPushedAt = now
      this.emit('hid:report', this.hid.snapshot())
      return
    }
    if (this.hidPushTimer) return
    this.hidPushTimer = setTimeout(() => {
      this.hidPushTimer = undefined
      if (!this.hid) return
      this.hidPushedAt = Date.now()
      this.emit('hid:report', this.hid.snapshot())
    }, HID_PUSH_MS - since)
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

  /**
   * What the cache holds for the attached board, and which of its axes the device has lost.
   *
   * Regression is computed here rather than in the renderer because the serial lives here — the
   * renderer never sees a board identity it could accidentally key on.
   */
  calCacheRead(): CalResult<{ board?: CachedBoard; regressed: number[] }> {
    const cache = loadCalCache()
    return {
      ok: true,
      value: {
        board: boardFor(cache, this.calSerialNumber),
        regressed: regressedAxes(cache, this.lastCal)
      }
    }
  }

  /** Record axes the device confirmed storing. A board with no serial is not cached at all. */
  calCacheStore(axes: CalCacheEntry[]): CalResult<null> {
    const serial = this.calSerialNumber
    if (!serial || axes.length === 0) return { ok: true, value: null }
    const entries: Record<number, CachedAxis> = {}
    for (const a of axes) {
      entries[a.idx] = { min: a.min, centre: a.centre, max: a.max, selfCentring: a.selfCentring }
    }
    saveCalCache(storeAxes(loadCalCache(), serial, entries, new Date().toISOString()))
    return { ok: true, value: null }
  }

  /** Forget a deliberately deleted axis, or the whole board on the reset-all index. */
  calCacheDrop(idx: number): CalResult<null> {
    const serial = this.calSerialNumber
    if (!serial) return { ok: true, value: null }
    saveCalCache(dropAxis(loadCalCache(), serial, idx === CAL_AXIS_NONE ? undefined : idx))
    return { ok: true, value: null }
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

  private setStatus(status: DeviceStatus): void {
    const prev = this.status
    // "Not found" repeats every retry; only a change is news to the renderer.
    if (
      prev.state === status.state &&
      prev.portPath === status.portPath &&
      prev.detail === status.detail
    ) {
      return
    }
    this.status = status
    this.emit('device:status', status)
    for (const cb of this.statusCbs) cb(status)
  }

  private raise(tag: string, message: string): void {
    for (const cb of this.errorCbs) cb(tag, message)
  }
}
