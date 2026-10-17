// DCS topic contract (arch-phase0-v2 §2.3): the relay to DCS-BIOS — its state, the stream it
// carries, recording and replay. Imported by main, preload and the renderer.
import type { DeviceState } from '../gateway/ipc'

/** DCS-BIOS endpoints: the export multicast group and port, and the command port. */
export const EXPORT_MULTICAST_ADDR = '239.255.50.10'
export const EXPORT_PORT = 5010
export const COMMAND_PORT = 7778

/**
 * Where the DCS-BIOS stream stands while relaying. TCP connects and can drop; UDP has nothing to
 * connect, so it is `connected` once the socket is bound; Replay is `connected` while playing and
 * `ended` when the capture runs out.
 */
export type StreamState = 'connecting' | 'connected' | 'reconnecting' | 'error' | 'ended'

/** The relay layer (#69): the one on/off, separate from the device link. */
export interface RelayState {
  running: boolean
  /** Absent while stopped. */
  stream?: StreamState
  detail?: string
}

export interface AircraftStatus {
  name: string // module name or "NONE"
  inferred: boolean // true if guessed from address range rather than _ACFT_NAME
  supported: boolean // false => non-A-4E warning banner
}

/** No aircraft named, and none inferred: the decoder's answer before DCS says anything. */
export const AIRCRAFT_NONE: AircraftStatus = { name: 'NONE', inferred: false, supported: true }

/** What a running relay is waiting for, if anything (the pill goes gold; the Start note says it). */
export type RelayWaiting = 'device' | 'dcs' | 'replay-ended' | 'none'

/** Which of the Relay pill's tooltips applies. */
export type RelayTip =
  | 'stopped'
  | 'waiting-device'
  | 'waiting-dcs'
  | 'delivering'
  | 'replay-stopped'
  | 'replay-ended'
  | 'replay-playing'

/** The Overview Link tile's sub-line: the relay under the device link. */
export type OverviewLink = 'gateway-relaying' | 'gateway-stopped' | 'waiting' | 'stopped'

/**
 * What the relay's surfaces show, for one state of the on/off. Main pushes it for both, so the
 * renderer's pending Start or Stop — shown at once, before main answers — reads the side it shows.
 */
export interface RelaySurfaces {
  waiting: RelayWaiting
  tip: RelayTip
  /** Start would be refused, by the mode that needs the board for it; absent = Start may go. */
  startBlocked?: 'bridge' | 'replay'
  overviewLink: OverviewLink
  /** May a recording start, on each surface that offers it (X12: they disagree). */
  canRecord: { connection: boolean; settings: boolean }
}

/** Where the stream comes from, as a surface labels it: fixed text, or the host and port typed. */
export type EndpointLabel = { text: string } | { hostPort: { suffix: string } }

/**
 * `relay:facts` (R3.3): what DcsRelay concludes for the Relay pill, the Connection tab's relay
 * controls, Settings › Connection and the Overview — main decides it (main/dcs/relay-rules.ts),
 * the renderer only reads it. Pushed whenever it changes: with the relay, the link, the settings,
 * a recording or a capture.
 */
export interface RelayFacts {
  /** As the surfaces read while the relay is shown running… */
  running: RelaySurfaces
  /** …and while it is shown stopped. */
  stopped: RelaySurfaces
  /** The stream and the link these were judged against, for the wording. */
  stream?: StreamState
  deviceState: DeviceState
  /** Each surface's own endpoint label (X9: they disagree). */
  endpoint: { pill: EndpointLabel; overview: EndpointLabel }
  /**
   * The recording as this page started it: off for a page that (re)loaded, whatever main is
   * doing (N1). `events`: how many the last stop saved.
   */
  recording: { on: boolean; events?: number }
  /**
   * Whether each surface shows its Record control at all (R3.4a, X12-style: they disagree). It
   * follows the source mode, not the on/off, so it is the same for both sides.
   */
  recordShown: { connection: boolean; settings: boolean }
  /** The capture this page loaded for Replay; none for a page that (re)loaded (N1). */
  replay?: { file: string; events: number; durationMs: number }
}

export interface StatsSnapshot {
  bytesInPerSec: number
  bytesOutPerSec: number
  framesPerSec: number
  commandsPerSec: number
  commandsTotal: number
  lastCommand?: string
  errors: number
  uptimeSec: number
  reconnects: number
}

export interface LogRow {
  t: number
  dir: 'in' | 'out' // client diagnostics are client events in the event log (#64)
  address: number
  name?: string
  value: number | string
  raw?: string
}

/**
 * The relay's facts as the renderer holds them before main has answered: the default settings
 * (Monitor, TCP to host), no device, stopped. Main's relayFacts() for those (pinned by
 * main/dcs/relay-rules.test.ts).
 */
export const RELAY_FACTS_IDLE: RelayFacts = {
  running: {
    waiting: 'dcs',
    tip: 'waiting-dcs',
    overviewLink: 'waiting',
    canRecord: { connection: true, settings: true }
  },
  stopped: {
    waiting: 'none',
    tip: 'stopped',
    overviewLink: 'stopped',
    canRecord: { connection: false, settings: true }
  },
  deviceState: 'no-device',
  endpoint: { pill: { hostPort: { suffix: '' } }, overview: { hostPort: { suffix: ' · remote' } } },
  recording: { on: false },
  recordShown: { connection: true, settings: true }
}

/** A gauge ring's colour: fuel low (alert), fuel, the secondary gauges, the rest. */
export type GaugeTone = 'fuel-low' | 'fuel' | 'secondary' | 'primary'

/** One sim-telemetry gauge readout (RPM / IAS / Flap / Press Alt / Fuel). */
export interface TelemetryReadout {
  id: string // A-4E-C output identifier driving this gauge
  label: string
  value: number // raw decoded value (or NaN when not exported)
  pct: number // 0..1 fill for the ring
  unit: string
  /** The ring's alert level, as main judges it (R3.3). */
  tone: GaugeTone
}

/**
 * The idle gauges (value NaN -> "—") the renderer shows until live telemetry arrives: the
 * decoder's idle variant (X10 — its ids and units are not the live readouts'; main pins them,
 * main/dcs/sim-telemetry-decoder.test.ts).
 */
export const TELEMETRY_IDLE: TelemetryReadout[] = [
  { id: 'RPM', label: 'RPM', value: NaN, pct: 0, unit: '% RPM', tone: 'primary' },
  { id: 'D_IAS_DEG', label: 'IAS', value: NaN, pct: 0, unit: '% FS', tone: 'primary' },
  { id: 'D_FLAPS_IND', label: 'Flap', value: NaN, pct: 0, unit: '% DN', tone: 'secondary' },
  { id: 'D_ALT_NEEDLE', label: 'Press Alt', value: NaN, pct: 0, unit: '% FS', tone: 'primary' },
  { id: 'D_FUEL', label: 'Fuel', value: NaN, pct: 0, unit: '% QTY', tone: 'fuel-low' }
]

export interface RelayResult {
  ok: boolean
  error?: string
}

export interface ExportResult {
  path?: string
}

export interface CaptureState {
  recording: boolean
  path?: string
  events?: number
}

export interface ReplayLoad {
  loaded: boolean
  path?: string
  events?: number
  durationMs?: number
}

export interface CaptureEvent {
  /** Milliseconds since capture start. */
  t: number
  /** "in" = export from DCS, "out" = command toward DCS. */
  dir: 'in' | 'out'
  /** Hex-encoded raw bytes. */
  hex: string
}

export interface CaptureMeta {
  aircraft?: string
  note?: string
}

/** This topic's main -> renderer pushes; shared/app assembles them into `PushChannels`. */
export interface DcsPushChannels {
  'relay:state': RelayState
  'aircraft:changed': AircraftStatus
  'stats:tick': StatsSnapshot
  'log:batch': LogRow[]
  'telemetry:tick': TelemetryReadout[]
  'relay:facts': RelayFacts
}

/** Push channel names (main -> renderer). */
export const DCS_PUSH = {
  relayState: 'relay:state',
  aircraftChanged: 'aircraft:changed',
  statsTick: 'stats:tick',
  logBatch: 'log:batch',
  telemetryTick: 'telemetry:tick',
  relayFacts: 'relay:facts'
} as const

/** Intent channel names (renderer -> main, invoke/response). */
export const DCS_CTRL = {
  relayStart: 'relay:start',
  relayStop: 'relay:stop',
  logExport: 'log:export',
  captureToggle: 'capture:toggle',
  replayOpen: 'replay:open',
  relayToggle: 'relay:toggle'
} as const
