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

/**
 * Whether the device link is up. The single definition every consumer keys on — calibration,
 * the nodes card, the Cockpit tab (#63) — so none of them invents its own.
 *
 * While it is down, link-scoped data (node model, telemetry) is left at its last state and
 * should be shown dimmed; there is no separate "stale" signal. HID is not link-scoped: the
 * joystick is read alongside DCS and keeps reporting with the serial port released (#74).
 */
export function isLinkUp(state: DeviceState): boolean {
  return state === 'connected'
}

export interface DeviceStatus {
  state: DeviceState
  portPath?: string
  vid?: number
  pid?: number
  detail?: string
  /**
   * The Gateway's own health (#94), only while `connected` and once there is something to say.
   * Computed once in main (shared/gateway.ts) and only read by the UI. Pushed on `device:status`
   * when it changes; the link state itself is unchanged by it.
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
}

/** One raw serial chunk for the live serial monitor. */
export interface SerialFrame {
  t: number
  dir: 'tx' | 'rx' // tx = host -> device, rx = device -> host
  hex: string
}

/** This topic's main -> renderer pushes; shared/app assembles them into `PushChannels`. */
export interface GatewayPushChannels {
  'device:status': DeviceStatus
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
