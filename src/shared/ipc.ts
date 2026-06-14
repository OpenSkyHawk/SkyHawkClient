// Typed IPC contract between the Electron main process and the renderer.
// Channels are one-way main -> renderer pushes; control actions are renderer -> main.

export type SourceMode = 'bridge' | 'monitor' | 'replay'
export type DcsTransport = 'loopback-multicast' | 'unicast-listen' | 'tcp-to-host'

export type DeviceState =
  | 'scanning'
  | 'connected'
  | 'relaying'
  | 'error'
  | 'reconnecting'
  | 'no-device'

export interface DeviceStatus {
  state: DeviceState
  portPath?: string
  vid?: number
  pid?: number
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
  dir: 'in' | 'out'
  address: number
  name?: string
  value: number | string
  raw?: string
}

export interface HidSnapshot {
  axes: number[] // 8 signed
  buttons: boolean[] // 128
  hats: number[] // 4 (0 = centre)
  ageMs: number // time since last report; large => idle
}

/** One sim-telemetry gauge readout (RPM / IAS / Flap / Press Alt / Fuel). */
export interface TelemetryReadout {
  id: string // A-4E-C output identifier driving this gauge
  label: string
  value: number // raw decoded value (or NaN when not exported)
  pct: number // 0..1 fill for the ring
  unit: string
}

// main -> renderer channel payloads
export interface PushChannels {
  'device:status': DeviceStatus
  'aircraft:changed': AircraftStatus
  'stats:tick': StatsSnapshot
  'log:batch': LogRow[]
  'hid:report': HidSnapshot
  'telemetry:tick': TelemetryReadout[]
}

export type PushChannel = keyof PushChannels

export const IPC = {
  deviceStatus: 'device:status',
  aircraftChanged: 'aircraft:changed',
  statsTick: 'stats:tick',
  logBatch: 'log:batch',
  hidReport: 'hid:report',
  telemetryTick: 'telemetry:tick'
} as const

// ── control (renderer -> main, invoke/response) ──────────────────────────────

export interface AppConfig {
  sourceMode: SourceMode
  transport: DcsTransport
  host: string
  commandPort: number
  listenPort: number // unicast-listen bind port
  autoReconnect: boolean
}

export const DEFAULT_CONFIG: AppConfig = {
  sourceMode: 'monitor',
  transport: 'tcp-to-host',
  host: '127.0.0.1',
  commandPort: 7778,
  listenPort: 5010,
  autoReconnect: true
}

export interface RelayResult {
  ok: boolean
  error?: string
}

export const CTRL = {
  configGet: 'config:get',
  configSet: 'config:set',
  relayStart: 'relay:start',
  relayStop: 'relay:stop'
} as const

/** The contextBridge surface exposed to the renderer as `window.skyhawk`. */
export interface SkyhawkApi {
  on<C extends PushChannel>(channel: C, cb: (data: PushChannels[C]) => void): () => void
  getConfig(): Promise<AppConfig>
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>
  startRelay(): Promise<RelayResult>
  stopRelay(): Promise<RelayResult>
}
