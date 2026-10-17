// The Gateway connection (#69): the SimGateway's USB serial port, and only that. Up whenever the
// board is plugged in, in every source mode, relaying or not; down only on unplug or an explicit
// disconnect. Finds, opens and retries the port, holds the link state and pushes it as
// `device:status`, writes, knows the board's USB serial, and runs the calibration frame filter on
// every byte that comes in.
//
// What else rides on the port is told about the link's moments through `ride()` (LinkRider): the
// serial monitor, calibration, HID, the node layer and the line tap (R2.2a, R2.2b). Device traffic
// goes out through onBytes(), below the frame filter: the relay (dcs/dcs-relay.ts) and the line tap
// (device-line-tap.ts) subscribe to it. Export goes in through write(). That split is the point.
// Bundled together, there was no node status, PDU telemetry, HID or calibration unless DCS was
// being relayed, and stopping the relay tore the port down with it.
import { isLinkUp, type DeviceStatus, type GatewayStatus } from '@shared/gateway'
import type { PushChannel, PushChannels } from '@shared/app'
import {
  findSimGatewayPort,
  listSerialPorts,
  PortNotFoundError,
  SerialBridge,
  SIMGATEWAY_PID,
  SIMGATEWAY_VID,
  type Log
} from './serial-bridge'

type Emit = <C extends PushChannel>(channel: C, payload: PushChannels[C]) => void

/**
 * The calibration frame filter on the incoming byte path (hid/calibration's HidCalibrationService
 * supplies it). GatewayConnection runs it on every chunk before anything else sees the bytes.
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
 * What rides on the link, and the link's moments it is told about.
 *
 * At each moment GatewayConnection calls its riders in the order they were added with `ride()`,
 * at exactly the point where that rider's code sat inside DeviceLink before the split, so the
 * order of side effects is unchanged. Session adds the serial monitor, calibration, HID, the node
 * layer (NodeHub's rider) and the line tap, in that order: see app/session.ts for which rider takes
 * part in which moment.
 */
export interface LinkRider {
  /**
   * start(): the rider's timers, on the link's list after its 200 ms tick. Same-period timers fire
   * in creation order, so this position is the push order; and they are cleared with the link's
   * own at shutdown.
   */
  timers?(every: LinkTimer): void
  /** start(): after the timers, before the first connect. */
  start?(): void
  /** shutdown(), disconnect(), and the port closing under the link: before anything else. */
  closing?(): void
  /** connect(): a new port, before any byte from it can arrive. */
  attach?(): void
  /** teardown(): the port is being released. First, before the port stops. */
  release?(): void
  /** teardown(): the port is released. Last. */
  released?(): void
  /** The port opened: first, before the connected status. What the link carries starts over. */
  opening?(): void
  /** The port opened: right after the connected status, before `opened`. */
  connected?(): void
  /** The port opened: after the connected status and the `connected` riders. */
  opened?(path: string): void
  /**
   * The port closed under us: after `closing`, before reconnecting or disconnecting.
   * `pass` sends bytes on down the stream, below the frame filter.
   */
  closed?(pass: (held: Buffer) => void): void
  /** The link's 200 ms push tick: first, and while the link is down too. */
  flush?(): void
  /** The link's 200 ms push tick, after `flush`: only while the link is up. */
  tick?(): void
  /** shutdown(): after the port is released. */
  stop?(): void
}

/**
 * What GatewayConnection needs from app (P6: it never asks electron): the debug log
 * (SerialBridge), the calibration frame filter, and the Gateway's health as the node layer follows
 * it (NodeHub drives GatewayWatch, UD-C), which the connected status carries.
 */
export interface GatewayConnectionDeps {
  log: Log
  frames: CalFrameFilter
  health: () => GatewayStatus | undefined
}

/** The link's push tick: node status, node model and the HID snapshot. */
const LINK_FLUSH_MS = 200

type Unsubscribe = () => void

function subscribe<T>(set: Set<T>, cb: T): Unsubscribe {
  set.add(cb)
  return () => set.delete(cb)
}

export class GatewayConnection {
  private serial?: SerialBridge
  private status: DeviceStatus = { state: 'disconnected' }
  private autoConnect = true
  private started = false
  private timers: ReturnType<typeof setInterval>[] = []
  /** In the order added: see LinkRider. */
  private readonly riders: LinkRider[] = []

  private readonly bytesCbs = new Set<(bytes: Buffer) => void>()
  private readonly trafficCbs = new Set<(dir: 'tx' | 'rx', chunk: Buffer) => void>()
  private readonly statusCbs = new Set<(status: DeviceStatus) => void>()
  private readonly errorCbs = new Set<(tag: string, message: string) => void>()

  constructor(
    private readonly emit: Emit,
    private readonly deps: GatewayConnectionDeps
  ) {}

  /** Add a rider. Riders are called in the order added; see LinkRider. */
  ride(rider: LinkRider): void {
    this.riders.push(rider)
  }

  // ── events ─────────────────────────────────────────────────────────────────

  /**
   * Device traffic with calibration frames removed — the DCS-BIOS command stream, byte for byte.
   * Fired whether or not anything relays it; forwarding is the relay's decision. Subscribers are
   * called in the order they subscribed.
   */
  onBytes(cb: (bytes: Buffer) => void): Unsubscribe {
    return subscribe(this.bytesCbs, cb)
  }

  /** Raw port traffic both ways, above the frame filter (the serial monitor's tap). */
  onTraffic(cb: (dir: 'tx' | 'rx', chunk: Buffer) => void): Unsubscribe {
    return subscribe(this.trafficCbs, cb)
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
    // The serial monitor's flush, calibration's cal:raw, HID's rate window, the node roster poll.
    for (const r of this.riders) r.timers?.(every)
    for (const r of this.riders) r.start?.() // HID: the reader
    if (autoConnect) this.connect()
    else this.setStatus({ state: 'disconnected' })
  }

  /** App quit. */
  shutdown(): void {
    for (const r of this.riders) r.closing?.() // nodes: when the boards were last seen (#93)
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
    s.onMonitor((dir, chunk) => {
      for (const cb of this.trafficCbs) cb(dir, chunk)
    })
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
    for (const r of this.riders) r.closing?.() // nodes: when the boards were last seen (#93)
    this.teardown()
    this.setStatus({ state: 'disconnected' })
  }

  /** Release the serial port and what rides on it. */
  private teardown(): void {
    for (const r of this.riders) r.release?.() // calibration: its CalLink and what it held
    this.serial?.stop()
    this.serial = undefined
    for (const r of this.riders) r.released?.() // nodes: the Gateway's health starts over
  }

  private onOpen(path: string): void {
    // A port open may be a different board, or the same one after an outage: node state starts
    // over, together. What survives is persisted (node-mapping.json) — names, adopted nodes, hidden
    // flags, last-seen times. Not on close: while unplugged the renderer shows the last state, dimmed.
    // Nodes: roster, node data, the Gateway's health, the v2 warning; the line tap: its assembler.
    for (const r of this.riders) r.opening?.()
    this.setStatus({
      state: 'connected',
      portPath: path,
      vid: SIMGATEWAY_VID,
      pid: SIMGATEWAY_PID,
      gateway: this.deps.health()
    })
    for (const r of this.riders) r.connected?.() // nodes: health just sent; seed the roster
    // Calibration reads what the board holds (badges, with no dialog open), then HID reopens.
    for (const r of this.riders) r.opened?.(path)
  }

  private onClose(): void {
    for (const r of this.riders) r.closing?.() // nodes: the boards were last seen now (#93)
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

  deviceStatus(): DeviceStatus {
    return this.status
  }

  /** A port is held — looking for the board, opening or open — from connect() until released. */
  get attached(): boolean {
    return !!this.serial
  }

  /** A calibration exchange holds the link (the frame filter says so). */
  get exportGated(): boolean {
    return this.deps.frames.exportGated
  }

  /**
   * USB serial of the attached gateway, for keying the calibration restore cache in #46.
   *
   * From SerialPort.list(), not node-hid: node-hid is an optional dependency that may be absent
   * entirely, and HidReader opens by VID/PID without exposing a serial. Confirmed on hardware —
   * the board reports 50031327805E871C. Absent or empty means no restore may be offered, since
   * guessing which board a cached calibration belongs to is the failure the key exists to stop.
   */
  async usbSerialNumber(): Promise<string | undefined> {
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

  // ── input ──────────────────────────────────────────────────────────────────

  private onSerialData(chunk: Buffer): void {
    // De-multiplex BEFORE anything else sees the chunk. Two reasons, and the first is the one
    // that bites: the relay sends this on to DCS's command socket, and during a session RAW
    // arrives at up to ~250 frames/s — that binary has no business reaching DCS. Second, the
    // gateway injects frames at arbitrary byte boundaries, so one can land mid-line; removing its
    // bytes is exactly what rejoins the interrupted line for the line tap's assembler.
    this.fromDevice(this.deps.frames.ingest(chunk))
  }

  /**
   * Everything downstream of the de-mux: hand the bytes to the relay, then to the line tap.
   *
   * Split out because it has a second caller. On port close the de-mux flushes any incomplete
   * candidate it was holding, and those bytes were never a frame — they belong to the DCS
   * stream. Dropping them would breach the byte-preservation guarantee the whole de-mux design
   * rests on. They must not be fed back through the de-mux, which is why this starts below it.
   */
  private fromDevice(rest: Buffer): void {
    if (rest.length === 0) return
    for (const cb of this.bytesCbs) cb(rest)
  }

  // ── renderer pushes ────────────────────────────────────────────────────────

  /**
   * The link's push tick: HID relaying or not, and — while the link is up — the node pushes and
   * the Gateway's health (NodeHub).
   *
   * Node pushes stop while the link is down, deliberately with no reset and no empty model: the
   * renderer keeps the last state and dims it from `device:status`. A stale-telemetry transition
   * computed during an unplug would only repeat what the link state already says.
   */
  private flushLink(): void {
    for (const r of this.riders) r.flush?.() // HID: its snapshot, link up or not
    if (!isLinkUp(this.status.state)) return
    for (const r of this.riders) r.tick?.() // nodes: node pushes, the Gateway's health
  }

  /**
   * The Gateway's health changed (NodeHub). Health rides on `device:status`, but it is not a
   * change of link state: no onStatus.
   */
  pushGatewayHealth(gateway: GatewayStatus | undefined): void {
    this.status = { ...this.status, gateway }
    this.emit('device:status', this.status)
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
