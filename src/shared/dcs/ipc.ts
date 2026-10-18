// DCS topic contract (arch-phase0-v2 §2.3): the relay to DCS-BIOS — its state, the stream it
// carries, recording and replay. Imported by main, preload and the renderer.
import type { DeviceState } from '../gateway/ipc'

/** DCS-BIOS endpoints: the export multicast group and port, and the command port. */
export const EXPORT_MULTICAST_ADDR = '239.255.50.10'
export const EXPORT_PORT = 5010
export const COMMAND_PORT = 7778

/** Where the relay's stream comes from (the settings' source mode). */
export type SourceMode = 'bridge' | 'monitor' | 'replay'
/** How the relay reaches DCS-BIOS (the settings' transport). */
export type DcsTransport = 'loopback-multicast' | 'unicast-listen' | 'tcp-to-host'

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

/**
 * The Overview Link tile's sub-line: the relay under the device link. `waiting` only while the
 * relay waits for the board (Bridge, a driven Replay); `running` when it runs without needing it.
 */
export type OverviewLink =
  | 'gateway-relaying'
  | 'gateway-stopped'
  | 'waiting'
  | 'running'
  | 'stopped'

/**
 * What the relay's surfaces show, for one state of the on/off. Main pushes it for both, so the
 * renderer's pending Start or Stop — shown at once, before main answers — reads the side it shows.
 */
export interface RelaySurfaces {
  waiting: RelayWaiting
  tip: RelayTip
  overviewLink: OverviewLink
  /**
   * May the Record control be used, on every surface that offers it (X12): a recording starts only
   * while relaying; one already on can always be stopped.
   */
  canRecord: boolean
}

/**
 * `relay:facts` (R3.3): what DcsRelay concludes for the Relay pill, the Connection tab's relay
 * controls, Settings › Connection and the Overview — main decides it (main/dcs/relay-rules.ts),
 * the renderer only reads it. Pushed whenever it changes: with the relay, the link, the settings,
 * a recording or a capture.
 */
export interface RelayFacts {
  /**
   * The source mode these were judged against (R3.4c). The Source Mode segment, its hint and the
   * title bar's SOURCE read it, so they flip in the same push as the cards, Start and the pill.
   */
  mode: SourceMode
  /**
   * The transport these were judged against (R3.4c). The Transport radios and the Overview's DCS
   * Link name read it, so they flip in the same push as the endpoints below.
   */
  transport: DcsTransport
  /** As the surfaces read while the relay is shown running… */
  running: RelaySurfaces
  /** …and while it is shown stopped. */
  stopped: RelaySurfaces
  /** The stream and the link these were judged against, for the wording. */
  stream?: StreamState
  deviceState: DeviceState
  /**
   * Where the stream comes from, as every surface labels it (X9: relay-rules relayEndpoint) — the
   * host and port for TCP, the multicast group, or the port Unicast listens on.
   */
  endpoint: string
  /**
   * The recording, as the Record control last answered: a page that (re)loads is handed it too
   * (N1). `events`: how many the last stop saved.
   */
  recording: { on: boolean; events?: number }
  /**
   * Whether each surface shows its Record control at all (R3.4a, X12-style: they disagree). It
   * follows the source mode, not the on/off, so it is the same for both sides.
   */
  recordShown: { connection: boolean; settings: boolean }
  /**
   * The Connection tab's Capture card shows (R3.4a: Replay only). The mirror of
   * `recordShown.connection`, decided beside it and pushed with it, so the two cards always flip
   * in the same push and are never on screen together.
   */
  captureShown: boolean
  /** The capture loaded for Replay; a page that (re)loads is handed it too (N1). */
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

export interface StreamRow {
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
  mode: 'monitor',
  transport: 'tcp-to-host',
  running: {
    waiting: 'dcs',
    tip: 'waiting-dcs',
    overviewLink: 'running',
    canRecord: true
  },
  stopped: {
    waiting: 'none',
    tip: 'stopped',
    overviewLink: 'stopped',
    canRecord: false
  },
  deviceState: 'no-device',
  endpoint: '127.0.0.1:7778',
  recording: { on: false },
  recordShown: { connection: true, settings: true },
  captureShown: false
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
 * The idle gauges (value NaN -> "—") the renderer shows until live telemetry arrives: the live
 * readouts with nothing decoded yet, in the same units (X10 — main pins it to the decoder's one
 * spec, main/dcs/sim-telemetry-decoder.test.ts).
 */
export const TELEMETRY_IDLE: TelemetryReadout[] = [
  { id: 'RPM', label: 'RPM', value: NaN, pct: 0, unit: '% RPM', tone: 'primary' },
  { id: 'D_IAS_DEG', label: 'IAS', value: NaN, pct: 0, unit: 'kt', tone: 'primary' },
  { id: 'D_FLAPS_IND', label: 'Flap', value: NaN, pct: 0, unit: '% DN', tone: 'secondary' },
  { id: 'ALT_FT', label: 'Press Alt', value: NaN, pct: 0, unit: 'ft', tone: 'secondary' },
  { id: 'D_FUEL', label: 'Fuel', value: NaN, pct: 0, unit: '% QTY', tone: 'fuel-low' }
]

export interface RelayResult {
  ok: boolean
  error?: string
}

export interface ExportResult {
  path?: string
}

export interface RecordState {
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
  'log:batch': StreamRow[]
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
