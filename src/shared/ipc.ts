// Typed IPC contract between the Electron main process and the renderer.
// Channels are one-way main -> renderer pushes; control actions are renderer -> main.
import type { NodeStatus } from './nodes'

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
  dir: 'in' | 'out' | 'sys' // sys = client diagnostic (serial/transport error, …)
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
  rateHz: number // reports/sec (on-change; 0 when idle)
}

/** One raw serial chunk for the live serial monitor. */
export interface SerialFrame {
  t: number
  dir: 'tx' | 'rx' // tx = host -> device, rx = device -> host
  hex: string
}

/** One sim-telemetry gauge readout (RPM / IAS / Flap / Press Alt / Fuel). */
export interface TelemetryReadout {
  id: string // A-4E-C output identifier driving this gauge
  label: string
  value: number // raw decoded value (or NaN when not exported)
  pct: number // 0..1 fill for the ring
  unit: string
}

/**
 * One RAW sample, timestamped **on arrival in main**.
 *
 * The timestamp is not optional bookkeeping. Samples are batched to the renderer, so wall-clock
 * at render time says when the batch flushed, not when the axis moved — and the capture logic's
 * dwell test is "the last received value has not changed for N ms". Reading the flush time would
 * make dwell depend on IPC scheduling.
 */
export interface CalRawSample {
  t: number
  idx: number
  /** Pre-transform sensor reading. Unsigned 0–65535, and displayed in those units. */
  raw: number
  /**
   * The same sample through the calibration the device currently holds — not a preview of the
   * endpoints being captured.
   *
   * Also unsigned 0–65535. One convention across this whole channel: converting this value but
   * not the endpoints is the silent-failure case.
   */
  cal: number
}

/** Stored calibration as last read back from the device. Drives the badges. */
export interface CalSnapshot {
  presentMask: number
  calibratedMask: number
  axes: {
    idx: number
    controlId: number
    min: number
    centre: number
    max: number
    deadzone: number
    present: boolean
    calibrated: boolean
  }[]
  /** USB serial of the board this came from; the restore cache is keyed by it. */
  serialNumber?: string
}

// main -> renderer channel payloads
export interface PushChannels {
  'device:status': DeviceStatus
  'aircraft:changed': AircraftStatus
  'stats:tick': StatsSnapshot
  'log:batch': LogRow[]
  'hid:report': HidSnapshot
  'telemetry:tick': TelemetryReadout[]
  'nodes:status': NodeStatus[]
  'serial:traffic': SerialFrame[]
  'cal:data': CalSnapshot
  'cal:raw': CalRawSample[]
}

export type PushChannel = keyof PushChannels

export const IPC = {
  deviceStatus: 'device:status',
  aircraftChanged: 'aircraft:changed',
  statsTick: 'stats:tick',
  logBatch: 'log:batch',
  hidReport: 'hid:report',
  telemetryTick: 'telemetry:tick',
  nodesStatus: 'nodes:status',
  serialTraffic: 'serial:traffic',
  calData: 'cal:data',
  calRaw: 'cal:raw'
} as const

// ── control (renderer -> main, invoke/response) ──────────────────────────────

export interface AppConfig {
  sourceMode: SourceMode
  transport: DcsTransport
  host: string
  commandPort: number
  listenPort: number // unicast-listen bind port
  autoReconnect: boolean
  replayDriveSerial: boolean // Replay mode: also write the replayed export to the SimGateway
  debugMode: boolean // write diagnostics (serial enumeration, device events) to a local log file
}

export const DEFAULT_CONFIG: AppConfig = {
  sourceMode: 'monitor',
  transport: 'tcp-to-host',
  host: '127.0.0.1',
  commandPort: 7778,
  listenPort: 5010,
  autoReconnect: true,
  replayDriveSerial: false,
  debugMode: false
}

const SOURCE_MODES: SourceMode[] = ['bridge', 'monitor', 'replay']
const TRANSPORTS: DcsTransport[] = ['loopback-multicast', 'unicast-listen', 'tcp-to-host']

/** Coerce arbitrary (e.g. persisted/untrusted) data into a valid AppConfig. */
export function sanitizeConfig(raw: unknown): AppConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppConfig>
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  return {
    sourceMode: SOURCE_MODES.includes(r.sourceMode as SourceMode)
      ? (r.sourceMode as SourceMode)
      : DEFAULT_CONFIG.sourceMode,
    transport: TRANSPORTS.includes(r.transport as DcsTransport)
      ? (r.transport as DcsTransport)
      : DEFAULT_CONFIG.transport,
    host: typeof r.host === 'string' && r.host ? r.host : DEFAULT_CONFIG.host,
    commandPort: num(r.commandPort, DEFAULT_CONFIG.commandPort),
    listenPort: num(r.listenPort, DEFAULT_CONFIG.listenPort),
    autoReconnect:
      typeof r.autoReconnect === 'boolean' ? r.autoReconnect : DEFAULT_CONFIG.autoReconnect,
    replayDriveSerial:
      typeof r.replayDriveSerial === 'boolean'
        ? r.replayDriveSerial
        : DEFAULT_CONFIG.replayDriveSerial,
    debugMode: typeof r.debugMode === 'boolean' ? r.debugMode : DEFAULT_CONFIG.debugMode
  }
}

export interface RelayResult {
  ok: boolean
  error?: string
}

/** Live session state so a freshly (re)loaded renderer can rehydrate. */
export interface RelayStatus {
  running: boolean
  device: DeviceStatus
  /**
   * Last calibration the device confirmed, if the link is still up.
   *
   * Carried here because `cal:data` is only pushed when the port opens. A renderer reload
   * creates a fresh store while the main-process session keeps running, so without this the
   * badges would stay blank until the next reconnect — indefinitely, on a stable link.
   */
  cal?: CalSnapshot
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

/** Report indices the firmware actually catalogues (the rest dim in the HID panel). */
export interface HidAvailability {
  axes: number[]
  hats: number[]
  buttons: number[]
}

export interface DebugDumpResult {
  path: string
  count: number
}

/**
 * Outcome of a calibration exchange.
 *
 * A discriminated result rather than a thrown error, because `ipcRenderer.invoke` flattens a
 * rejection into a plain Error — which would collapse the one distinction the failure design
 * depends on. A **timeout** and a **nack** need opposite messages: a timeout means no frame
 * came back, so the connection is suspect and the outcome is genuinely unknown; a nack means
 * the device answered and refused, so the connection is fine and the values are the problem.
 *
 * `timeout` deliberately does not imply "nothing was written". It cannot distinguish "never
 * received" from "wrote it and the reply was lost", so callers re-read and report what the
 * device says.
 */
export type CalFailure =
  | { kind: 'timeout'; message: string }
  | { kind: 'nack'; reason: number; reasonName: string; detail: number; message: string }
  | { kind: 'offline'; message: string }
  | { kind: 'error'; message: string }

export type CalResult<T> = { ok: true; value: T } | ({ ok: false } & CalFailure)

export interface CalHello {
  proto: number
  blobVersion: number
  axisSlots: number
  fw: { major: number; minor: number; patch: number }
}

export interface CalCommitAxis {
  idx: number
  /**
   * Unsigned 0–65535 calibration-channel counts — positions in the node's ADC space, exactly as
   * the device stores them.
   *
   * **Pass through unchanged.** These are the same units the dialog displays and the capture
   * logic works in, so there is no conversion to undo. The client applies no offset anywhere;
   * the −32768 lives once in the firmware, at SimGateway.cpp:216, on the way into the HID report.
   */
  min: number
  centre: number
  max: number
}

export const CTRL = {
  configGet: 'config:get',
  configSet: 'config:set',
  relayStart: 'relay:start',
  relayStop: 'relay:stop',
  relayStatus: 'relay:status',
  logExport: 'log:export',
  captureToggle: 'capture:toggle',
  replayOpen: 'replay:open',
  hidAvailability: 'hid:availability',
  nodesRefresh: 'nodes:refresh',
  serialMonitor: 'serial:monitor',
  debugDumpPorts: 'debug:dump-ports',
  debugReveal: 'debug:reveal',
  calHello: 'cal:hello',
  calRead: 'cal:read',
  calSessionOpen: 'cal:session-open',
  calStreamSelect: 'cal:stream-select',
  calCommit: 'cal:commit',
  calReset: 'cal:reset',
  calSessionClose: 'cal:session-close'
} as const

/** The contextBridge surface exposed to the renderer as `window.skyhawk`. */
export interface SkyhawkApi {
  on<C extends PushChannel>(channel: C, cb: (data: PushChannels[C]) => void): () => void
  getConfig(): Promise<AppConfig>
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>
  startRelay(): Promise<RelayResult>
  stopRelay(): Promise<RelayResult>
  getStatus(): Promise<RelayStatus>
  exportLog(text: string): Promise<ExportResult>
  toggleCapture(): Promise<CaptureState>
  openReplay(): Promise<ReplayLoad>
  getHidAvailability(): Promise<HidAvailability>
  refreshNodes(): Promise<void>
  setSerialMonitor(on: boolean): Promise<void>
  dumpSerialPorts(): Promise<DebugDumpResult>
  revealDebugLog(): Promise<void>

  // ── axis calibration (#46) ────────────────────────────────────────────────
  // hello/read are answered outside a session, so badges work with no dialog open.
  calHello(): Promise<CalResult<CalHello>>
  calRead(): Promise<CalResult<CalSnapshot>>
  /** Opens a session and streams RAW for one axis. 0xFF streams none. */
  calSessionOpen(axisIdx: number): Promise<CalResult<{ timeoutMs: number; axisIdx: number }>>
  calStreamSelect(axisIdx: number): Promise<CalResult<null>>
  /** Writes and persists exactly one axis. Acknowledged != stored; follow with calRead(). */
  calCommit(axis: CalCommitAxis): Promise<CalResult<null>>
  /** Deletes stored calibration for one axis, or all with 0xFF. Persists immediately. */
  calReset(idx: number): Promise<CalResult<null>>
  calSessionClose(): Promise<CalResult<null>>
}
