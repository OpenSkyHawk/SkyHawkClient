// DCS topic contract (arch-phase0-v2 §2.3): the relay to DCS-BIOS — its state, the stream it
// carries, recording and replay. Imported by main, preload and the renderer.

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

/** One sim-telemetry gauge readout (RPM / IAS / Flap / Press Alt / Fuel). */
export interface TelemetryReadout {
  id: string // A-4E-C output identifier driving this gauge
  label: string
  value: number // raw decoded value (or NaN when not exported)
  pct: number // 0..1 fill for the ring
  unit: string
}

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
}

/** Push channel names (main -> renderer). */
export const DCS_PUSH = {
  relayState: 'relay:state',
  aircraftChanged: 'aircraft:changed',
  statsTick: 'stats:tick',
  logBatch: 'log:batch',
  telemetryTick: 'telemetry:tick'
} as const

/** Intent channel names (renderer -> main, invoke/response). */
export const DCS_CTRL = {
  relayStart: 'relay:start',
  relayStop: 'relay:stop',
  logExport: 'log:export',
  captureToggle: 'capture:toggle',
  replayOpen: 'replay:open'
} as const
