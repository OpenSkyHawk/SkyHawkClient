// The device link (#69): the SimGateway serial port, the node roster and the node data layer. Up
// whenever the board is plugged in, in every source mode, relaying or not; down only on unplug or an
// explicit disconnect.
//
// What else rides on the port — calibration (hid/calibration HidCalibrationService) and HID
// (hid HidService) — is told about the link's moments through `ride()` (R2.2a), and event-log rows
// go to the EventJournal through `report`.
//
// The relay (app/session.ts) attaches to it rather than owning it: export goes out through write(),
// and device traffic comes back through onBytes() / onLine(). That split is the point. Bundled
// together, there was no node status, PDU telemetry, HID or calibration unless DCS was being
// relayed, and stopping the relay tore the port down with it.
import type { LogEventInput } from '@shared/events'
import { isLinkUp, type DeviceStatus, type SerialFrame } from '@shared/gateway'
import type { PushChannel, PushChannels } from '@shared/app'
import {
  PortNotFoundError,
  SerialBridge,
  SIMGATEWAY_PID,
  SIMGATEWAY_VID,
  type Log
} from './serial-bridge'
import { GatewayWatch } from './gateway-health'
import { LineAssembler, parseCommand } from './link-framing'
import {
  BRIDGE_NODE_ID,
  NODE_END_MSG,
  NODE_MSG,
  NODE_TELEM_MSG,
  NodeHub,
  NodeRoster,
  cleanNodeLine,
  isLegacyNodeStatus,
  nodeRosterRequest,
  parseNodeStatus,
  withFaultInfo,
  type MappingFileIO
} from '../nodes'

type Emit = <C extends PushChannel>(channel: C, payload: PushChannels[C]) => void

/**
 * The calibration frame filter on the incoming byte path (hid/calibration's HidCalibrationService
 * supplies it). DeviceLink runs it on every chunk before anything else sees the bytes.
 */
export interface CalFrameFilter {
  /** Feed inbound bytes; what is not a calibration frame comes back, for DCS and the line taps. */
  ingest(chunk: Buffer): Buffer
  /** A calibration exchange is in flight, and the export stream must not be forwarded. */
  readonly exportGated: boolean
}

/** Adds one interval to the link's own timer list: created in start(), cleared at shutdown. */
export type LinkTimer = (ms: number, fn: () => void) => void

/**
 * What rides on the link — calibration and HID (R2.2a) — and the link's moments it is told about.
 *
 * At each moment DeviceLink calls its riders in the order they were added with `ride()`, at exactly
 * the point where that rider's code sat inside DeviceLink before the split, so the order of side
 * effects is unchanged. Session adds calibration first, then HID: where both handle a moment
 * (start's timers, a port opening), calibration's part came first.
 */
export interface LinkRider {
  /**
   * start(): the rider's timers, on the link's list between its serial flush and its roster poll.
   * Same-period timers fire in creation order, so this position is the push order; and they are
   * cleared with the link's own at shutdown.
   */
  timers?(every: LinkTimer): void
  /** start(): after the link's timers, before the first connect. */
  start?(): void
  /** connect(): a new port, before any byte from it can arrive. */
  attach?(): void
  /** teardown(): the port is being released. First, before the port stops. */
  release?(): void
  /** The port opened: after the link's own resets, its status push and the roster request. */
  opened?(path: string): void
  /**
   * The port closed under us: after the node layer noted it, before reconnecting or disconnecting.
   * `pass` sends bytes on down the stream, below the frame filter.
   */
  closed?(pass: (held: Buffer) => void): void
  /** The link's 200 ms push tick: first, and while the link is down too. */
  flush?(): void
  /** shutdown(): after the port is released. */
  stop?(): void
}

/**
 * What DeviceLink needs from app (P6: it never asks electron): node-mapping.json as a port (for
 * NodeHub), the debug log (NodeHub, SerialBridge), where event-log rows go (EventJournal), and the
 * calibration frame filter.
 */
export interface DeviceLinkDeps {
  mappingFile: MappingFileIO
  log: Log
  /** Event-log rows: node changes and the Gateway's health (EventJournal.report). */
  report: (events: LogEventInput[]) => void
  frames: CalFrameFilter
}

/** Node status, node model and the HID snapshot. Same cadence the relay used for them. */
const LINK_FLUSH_MS = 200
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
  /** A v2 (pre-#344) PanelBridge was reported this link: say it once, not on every row. */
  private legacyNodesWarned = false
  /** Node telemetry, mapping and the combined node model (#61). */
  readonly nodes: NodeHub
  /** The Gateway's own health (#94): its node-0 row, and whether it still answers. */
  private readonly gateway = new GatewayWatch()
  private serial?: SerialBridge
  private assembler = new LineAssembler()
  private serialMonitor = false
  private serialBuf: SerialFrame[] = []
  private status: DeviceStatus = { state: 'disconnected' }
  private autoConnect = true
  private started = false
  private timers: ReturnType<typeof setInterval>[] = []
  /** Calibration, then HID: see LinkRider. */
  private readonly riders: LinkRider[] = []

  private readonly bytesCbs = new Set<(bytes: Buffer) => void>()
  private readonly lineCbs = new Set<(line: DeviceLine) => void>()
  private readonly statusCbs = new Set<(status: DeviceStatus) => void>()
  private readonly errorCbs = new Set<(tag: string, message: string) => void>()

  constructor(
    private readonly emit: Emit,
    private readonly deps: DeviceLinkDeps
  ) {
    this.nodes = new NodeHub(emit, this.roster, (events) => this.deps.report(events), deps)
  }

  /** Add a rider. Riders are called in the order added; see LinkRider. */
  ride(rider: LinkRider): void {
    this.riders.push(rider)
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

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /** App launch: start the link's timers and, unless the user opted out, the link itself. */
  start(autoConnect: boolean): void {
    if (this.started) return
    this.started = true
    this.autoConnect = autoConnect
    this.timers = []
    const every: LinkTimer = (ms, fn) => {
      this.timers.push(setInterval(fn, ms))
    }
    every(LINK_FLUSH_MS, () => this.flushLink())
    every(SERIAL_FLUSH_MS, () => this.flushSerial())
    for (const r of this.riders) r.timers?.(every) // calibration: cal:raw; HID: the rate window
    // Poll the node roster so silent deaths get reconciled — relaying or not.
    every(NODES_REFRESH_MS, () => this.requestNodes())
    for (const r of this.riders) r.start?.() // HID: the reader
    if (autoConnect) this.connect()
    else this.setStatus({ state: 'disconnected' })
  }

  /** App quit. */
  shutdown(): void {
    this.nodes.linkClosed() // remember when the boards on the bus were last seen (#93)
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.teardown()
    for (const r of this.riders) r.stop?.() // HID: the pending push, the reader
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
    const s = new SerialBridge(true, this.deps.log)
    this.serial = s
    for (const r of this.riders) r.attach?.() // calibration: a CalLink for this port
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
    this.nodes.linkClosed()
    this.teardown()
    this.setStatus({ state: 'disconnected' })
  }

  /** Release the serial port and what rides on it. */
  private teardown(): void {
    for (const r of this.riders) r.release?.() // calibration: its CalLink and what it held
    this.serial?.stop()
    this.serial = undefined
    this.gateway.reset()
  }

  private onOpen(path: string): void {
    // A port open may be a different board, or the same one after an outage: node state starts
    // over, together. What survives is persisted (node-mapping.json) — names, adopted nodes, hidden
    // flags, last-seen times. Not on close: while unplugged the renderer shows the last state, dimmed.
    this.roster.reset()
    this.nodes.reset()
    this.gateway.reset()
    this.legacyNodesWarned = false
    this.assembler = new LineAssembler() // a line cut by the unplug must not prefix the next one
    this.setStatus({
      state: 'connected',
      portPath: path,
      vid: SIMGATEWAY_VID,
      pid: SIMGATEWAY_PID,
      gateway: this.gateway.status()
    })
    this.gateway.takeChanged() // just sent
    this.requestNodes() // seed the roster as soon as the device is up
    // Calibration reads what the board holds (badges, with no dialog open), then HID reopens.
    for (const r of this.riders) r.opened?.(path)
  }

  private onClose(): void {
    this.nodes.linkClosed() // the boards on the bus were last seen now (#93)
    // Calibration fails what is in flight and hands back held bytes, which go on down the relay.
    for (const r of this.riders) r.closed?.((held) => this.fromDevice(held))
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

  /** Ask PanelBridge for the full node roster (inject the request export to the serial). */
  requestNodes(): void {
    if (!this.serial || !isLinkUp(this.status.state)) return
    this.roster.beginBurst() // isolate the reply burst so prior deltas don't block pruning
    this.gateway.asked(Date.now())
    this.serial.write(Buffer.from(nodeRosterRequest()))
  }

  deviceStatus(): DeviceStatus {
    return this.status
  }

  // ── input ──────────────────────────────────────────────────────────────────

  private onSerialData(chunk: Buffer): void {
    // De-multiplex BEFORE anything else sees the chunk. Two reasons, and the first is the one
    // that bites: the relay sends this on to DCS's command socket, and during a session RAW
    // arrives at up to ~250 frames/s — that binary has no business reaching DCS. Second, the
    // gateway injects frames at arbitrary byte boundaries, so one can land mid-line; removing its
    // bytes is exactly what rejoins the interrupted line for the assembler below.
    this.fromDevice(this.deps.frames.ingest(chunk))
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
    for (const raw of this.assembler.push(rest)) {
      if (!raw.trim()) continue
      // UART noise from a bridge reset can precede the first node-status row; cut it off.
      const line = cleanNodeLine(raw)
      const { identifier, arg } = parseCommand(line)
      if (identifier === NODE_MSG && !this.legacyNodesWarned && isLegacyNodeStatus(arg.trim())) {
        // Every v2 row would be dropped as malformed, leaving the Cockpit silently empty.
        this.legacyNodesWarned = true
        this.raise(
          'NODES',
          'The Gateway sends node status v2; this client needs v3 — update the Gateway firmware (OpenSkyhawk#344)'
        )
      }
      let kind: DeviceLine['kind'] = 'command'
      // Node-status messages are tapped to the roster, not logged as panel commands.
      if (identifier === NODE_MSG || identifier === NODE_END_MSG) {
        this.deps.log('node', `${identifier} ${arg}`.trim())
        this.roster.applyMessage(identifier, arg, t)
        this.nodes.statusLine(identifier, line.trim(), t)
        this.gatewayLine(identifier, arg, line.trim(), t)
        kind = 'node'
      } else if (identifier === NODE_TELEM_MSG) {
        // Node telemetry (~1/s per PDU) likewise: tapped, never logged as a panel command.
        this.nodes.telemetry(arg, t, line.trim())
        kind = 'node'
      }
      for (const cb of this.lineCbs) cb({ kind, identifier, arg, line: line.trim(), t })
    }
  }

  /**
   * Any node-status line answers the roster request; the Gateway's own row (node 0) is its health.
   * That row stays out of the cockpit model (node-model); this is where it is shown instead (#94).
   */
  private gatewayLine(identifier: string, arg: string, raw: string, t: number): void {
    this.deps.report(this.gateway.answered(raw, t))
    if (identifier !== NODE_MSG) return
    const n = parseNodeStatus(arg.trim())
    if (n?.nodeId === BRIDGE_NODE_ID)
      this.deps.report(this.gateway.report(withFaultInfo(n), raw, t))
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
    for (const r of this.riders) r.flush?.() // HID: its snapshot, link up or not
    if (!isLinkUp(this.status.state)) return
    this.nodes.flush(this.roster.takeDirty())
    this.deps.report(this.gateway.tick(Date.now(), this.deps.frames.exportGated))
    if (this.gateway.takeChanged()) {
      // Health rides on `device:status`, but it is not a change of link state: no onStatus.
      this.status = { ...this.status, gateway: this.gateway.status() }
      this.emit('device:status', this.status)
    }
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
