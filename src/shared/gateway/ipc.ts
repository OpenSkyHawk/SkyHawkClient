// Gateway topic contract (arch-phase0-v2 §2.3): the device link — the Gateway's serial port and the
// Gateway's own health — and the raw serial view. Imported by main, preload and the renderer.

/**
 * State of the device link — the Gateway's serial port, and with it calibration, HID and the
 * node roster. Independent of the relay (#69): the link is up whenever the board is plugged in,
 * relaying or not, so nothing here says whether DCS-BIOS is flowing. That is `RelayState`.
 *
 * - `no-device`    nothing enumerated; still looking
 * - `scanning`     looking for the board / opening the port
 * - `connected`    port open — the one state in which the link is up
 * - `reconnecting` the port dropped; briefly, until the board is found again or found gone
 * - `error`        the port is there but would not open (e.g. held by another program); retrying
 * - `disconnected` closed on purpose: Disconnect pressed, or "connect automatically" is off
 */
export type DeviceState =
  | 'no-device'
  | 'scanning'
  | 'connected'
  | 'reconnecting'
  | 'error'
  | 'disconnected'

export interface DeviceStatus {
  state: DeviceState
  portPath?: string
  vid?: number
  pid?: number
  detail?: string
  /**
   * The Gateway's own health (#94), only while `connected` and once there is something to say.
   * Computed once in main (main/gateway/gateway-health.ts) and only read by the UI. Pushed on
   * `device:status` when it changes; the link state itself is unchanged by it. `device:status` never carries it
   * while the link is down (main/gateway/gateway-health.ts shownStatus, R3.4a).
   */
  gateway?: GatewayStatus
}

export type GatewayKind =
  | 'ok'
  | 'not-responding'
  | 'bus-off'
  | 'overheat'
  | 'error-passive'
  | 'fault'

/** What the client shows about the Gateway. Carried on `DeviceStatus` while connected. */
export interface GatewayStatus {
  /** err: panel input can't reach DCS. warn: it reports a problem but still works. */
  severity: 'ok' | 'warn' | 'err'
  /** The worst thing it reports; only that one is shown. */
  kind: GatewayKind
  /** `OK · 42 °C`, `Overheat · 78 °C`, `Error-passive`, `Duplicate NODE_ID`, `Bus-off`, `Not responding`. */
  label: string
  /** One line on what it means and what to do; absent when healthy. */
  note?: string
  /** Serious faults only (severity err): the Overview alert. */
  alert?: { head: string; text: string }
  /**
   * It says how the link is, not something the Gateway reports (not responding): the popover's
   * title and line show it, in place of a Health row (R3.4a: gateway-view.ts's choice before).
   */
  aboutLink?: true
}

/**
 * The link's one action, for the state it is in (R3.4a): which button the device card and the
 * Device popover offer, what it does, and whether it is available. GatewayConnection decides it
 * (main/gateway/link-state.ts linkAction); the renderer words it.
 */
export interface LinkAction {
  /** Which button shows. */
  offer: 'connect' | 'disconnect' | 'retry'
  /** What it does: the intent it sends (`device:connect` / `device:disconnect`). */
  intent: 'connect' | 'disconnect'
  /** While the port is mid-open there is nothing sensible to interrupt. */
  disabled?: true
}

/**
 * What main concludes from the link (R3.3), pushed with every `device:status` and in the
 * rehydrate bundle: GatewayConnection decides it (main/gateway/link-state.ts), the renderer only
 * reads it. While the link is down, link-scoped data (node model, telemetry) is left at its last
 * state and shown dimmed; there is no separate "stale" signal.
 */
export interface DeviceLinkFacts {
  /** The port is open: the one state in which the link is up. */
  linkUp: boolean
  /** The board is plugged in as far as the link can tell, so HID reports can arrive (#74). */
  boardPresent: boolean
  /** The port would not open because another program holds it (from `detail`). */
  busy: boolean
  /**
   * When the link last went down after being up: the Cockpit's "last known" time. Absent while up,
   * and, as before, for a page that (re)loaded until the link next drops (N1).
   */
  linkDownAt?: number
  /** The Serial tab's raw monitor is on, as this page last set it; off for a reloaded page (N1). */
  serialMonitor: boolean
  /** The device card's and the Device popover's button (R3.4a). */
  action: LinkAction
}

/** `device:status` as main pushes it: the link's status and what it concludes from it. */
export type DeviceStatusPush = DeviceStatus & DeviceLinkFacts

/**
 * The link as the renderer holds it before main has answered: no device, nothing concluded. Main's
 * linkFacts() of `{ state: 'no-device' }` (pinned by main/gateway/link-state.test.ts).
 */
export const DEVICE_IDLE: DeviceStatusPush = {
  state: 'no-device',
  linkUp: false,
  boardPresent: false,
  busy: false,
  serialMonitor: false,
  action: { offer: 'disconnect', intent: 'disconnect' }
}

/** One raw serial chunk for the live serial monitor. */
export interface SerialFrame {
  t: number
  dir: 'tx' | 'rx' // tx = host -> device, rx = device -> host
  hex: string
}

/** This topic's main -> renderer pushes; shared/app assembles them into `PushChannels`. */
export interface GatewayPushChannels {
  'device:status': DeviceStatusPush
  'serial:traffic': SerialFrame[]
}

/** Push channel names (main -> renderer). */
export const GATEWAY_PUSH = {
  deviceStatus: 'device:status',
  serialTraffic: 'serial:traffic'
} as const

/** Intent channel names (renderer -> main, invoke/response). */
export const GATEWAY_CTRL = {
  deviceConnect: 'device:connect',
  deviceDisconnect: 'device:disconnect',
  serialMonitor: 'serial:monitor'
} as const
