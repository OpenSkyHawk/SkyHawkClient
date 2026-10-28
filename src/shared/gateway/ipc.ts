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
  /**
   * Its cockpit side hasn't reported its health yet, but it recovered itself (#169), which is
   * enough for a status. No surface of its own: the Health row is hidden, the event log reads it as `ok`.
   */
  | 'unreported'

/**
 * How the Gateway recovered itself this boot (#169, from its DIAG record): a watchdog reset, a
 * recovery-ladder reboot, or a software re-plug of its link to this computer.
 */
export type GatewayRecoveredHow = 'watchdog' | 'recovery' | 're-plug'

/** What the client shows about the Gateway. Carried on `DeviceStatus` while connected. */
export interface GatewayStatus {
  /**
   * err: panel input can't reach DCS. warn: it reports a problem but still works, or it recovered
   * itself this boot. The worse of the two when both.
   */
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
  /** The Gateway's own firmware release, from its own status row (#171). */
  firmware?: GatewayFirmware
  /**
   * It re-plugged or restarted itself this boot (#169): evidence, not a fault. A second fact
   * beside `kind`, so neither hides the other; on its own it makes the status `warn`, never `err`
   * and never the alert. `note` is the popover's line. Shown on every connection to that boot,
   * until a power-on (a replug) clears it.
   */
  recovered?: { how: GatewayRecoveredHow; note: string }
}

/** A firmware release as a board reports it (`_NODE_STATUS` v4). */
export interface FirmwareVersion {
  major: number
  minor: number
  patch: number
}

/** The Gateway's firmware as main judges it (#171). */
export interface GatewayFirmware {
  /** null: the row reports 0.0.0. No released build does. */
  version: FirmwareVersion | null
  /** Its major is newer than the major this client supports: some status may be missing or wrong. */
  tooNew: boolean
  /** The firmware major this client supports: `SUPPORTED_FIRMWARE_MAJOR` (gateway/firmware.ts). */
  supportedMajor: number
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
   * When the link last went down after being up: the Cockpit's "last known" time. Absent while up;
   * a page that (re)loads is handed it too (N1).
   */
  linkDownAt?: number
  /** The Serial tab's raw monitor is on, as it was last set; a reloaded page too (N1). */
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
