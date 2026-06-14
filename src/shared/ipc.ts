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

// main -> renderer channel payloads
export interface PushChannels {
  'device:status': DeviceStatus
  'aircraft:changed': AircraftStatus
  'stats:tick': StatsSnapshot
  'log:batch': LogRow[]
  'hid:report': HidSnapshot
}

export type PushChannel = keyof PushChannels

export const IPC = {
  deviceStatus: 'device:status',
  aircraftChanged: 'aircraft:changed',
  statsTick: 'stats:tick',
  logBatch: 'log:batch',
  hidReport: 'hid:report'
} as const
