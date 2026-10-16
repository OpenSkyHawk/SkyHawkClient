// Typed IPC contract between the Electron main process and the renderer.
// Channels are one-way main -> renderer pushes; control actions are renderer -> main.
import type { CachedAxis, CachedBoard } from './cal-cache'
import type { NodeStatus } from './nodes'
import type { NodeTelemSnapshot } from './node-telem'
import type { AdoptSpec, MappingPatch } from './node-mapping'
import type { NodeModel } from './node-rules'

export type SourceMode = 'bridge' | 'monitor' | 'replay'
export type DcsTransport = 'loopback-multicast' | 'unicast-listen' | 'tcp-to-host'

/**
 * State of the device link — the SimGateway serial port, and with it calibration, HID and the
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
 * Whether the device link is up. The single definition every consumer keys on — HID freshness,
 * calibration badges, the nodes card, the Cockpit tab (#63) — so none of them invents its own.
 *
 * While it is down, link-scoped data (node model, telemetry, HID) is left at its last state and
 * should be shown dimmed; there is no separate "stale" signal.
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
}

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
//
// Two scopes (#69). **Link-scoped** pushes flow whenever the device link is up, relaying or not:
// device:status, hid:report, nodes:*, serial:traffic, cal:*. On link down they stop and the
// renderer keeps the last state, dimmed via isLinkUp(). **Relay-scoped** pushes flow only while
// relaying: relay:state changes, aircraft:changed, stats:tick, telemetry:tick. log:batch carries
// both (panel commands and link errors are logged while stopped too).
export interface PushChannels {
  'device:status': DeviceStatus
  'relay:state': RelayState
  'aircraft:changed': AircraftStatus
  'stats:tick': StatsSnapshot
  'log:batch': LogRow[]
  'hid:report': HidSnapshot
  'telemetry:tick': TelemetryReadout[]
  'nodes:status': NodeStatus[]
  /** Latest PDU telemetry per node (#61). At most once a second, and only on change. */
  'nodes:telemetry': NodeTelemSnapshot[]
  /** Roster + telemetry + node mapping combined: what the Cockpit tab shows (#61, UI in #63). */
  'nodes:model': NodeModel
  'serial:traffic': SerialFrame[]
  'cal:data': CalSnapshot
  'cal:raw': CalRawSample[]
}

export type PushChannel = keyof PushChannels

export const IPC = {
  deviceStatus: 'device:status',
  relayState: 'relay:state',
  aircraftChanged: 'aircraft:changed',
  statsTick: 'stats:tick',
  logBatch: 'log:batch',
  hidReport: 'hid:report',
  telemetryTick: 'telemetry:tick',
  nodesStatus: 'nodes:status',
  nodesTelemetry: 'nodes:telemetry',
  nodesModel: 'nodes:model',
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
  /**
   * Open the SimGateway on launch and on plug-in, and reopen it after a drop (#69). Off: the
   * client never takes the port on its own — for anyone sharing it with socat or similar — and
   * the link opens only on an explicit connect.
   */
  autoConnect: boolean
  replayDriveSerial: boolean // Replay mode: also write the replayed export to the SimGateway
  debugMode: boolean // write diagnostics (serial enumeration, device events) to a local log file
}

export const DEFAULT_CONFIG: AppConfig = {
  sourceMode: 'monitor',
  transport: 'tcp-to-host',
  host: '127.0.0.1',
  commandPort: 7778,
  listenPort: 5010,
  autoConnect: true,
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
    // The old `autoReconnect` is not carried over: it governed reopen-after-drop for a link that
    // only existed while relaying, and connecting by default is the intended behaviour now.
    autoConnect: typeof r.autoConnect === 'boolean' ? r.autoConnect : DEFAULT_CONFIG.autoConnect,
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
  relay: RelayState
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
  deviceConnect: 'device:connect',
  deviceDisconnect: 'device:disconnect',
  logExport: 'log:export',
  captureToggle: 'capture:toggle',
  replayOpen: 'replay:open',
  hidAvailability: 'hid:availability',
  nodesRefresh: 'nodes:refresh',
  nodesGet: 'nodes:get',
  nodeMappingSet: 'node-mapping:set',
  nodeMappingAdopt: 'node-mapping:adopt',
  nodeMappingForget: 'node-mapping:forget',
  nodeMappingReset: 'node-mapping:reset',
  nodeMappingIgnore: 'node-mapping:ignore',
  nodeMappingHide: 'node-mapping:hide',
  serialMonitor: 'serial:monitor',
  debugDumpPorts: 'debug:dump-ports',
  debugReveal: 'debug:reveal',
  calHello: 'cal:hello',
  calRead: 'cal:read',
  calSessionOpen: 'cal:session-open',
  calStreamSelect: 'cal:stream-select',
  calCommit: 'cal:commit',
  calReset: 'cal:reset',
  calSessionClose: 'cal:session-close',
  calCacheRead: 'cal:cache-read',
  calCacheStore: 'cal:cache-store',
  calCacheDrop: 'cal:cache-drop'
} as const

/** The contextBridge surface exposed to the renderer as `window.skyhawk`. */
export interface SkyhawkApi {
  on<C extends PushChannel>(channel: C, cb: (data: PushChannels[C]) => void): () => void
  getConfig(): Promise<AppConfig>
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>
  startRelay(): Promise<RelayResult>
  stopRelay(): Promise<RelayResult>
  getStatus(): Promise<RelayStatus>
  /** Open the device link now, whatever "connect automatically" says. */
  connectDevice(): Promise<void>
  /** Close the device link and keep it closed — through a replug — until connectDevice(). */
  disconnectDevice(): Promise<void>
  exportLog(text: string): Promise<ExportResult>
  toggleCapture(): Promise<CaptureState>
  openReplay(): Promise<ReplayLoad>
  getHidAvailability(): Promise<HidAvailability>
  refreshNodes(): Promise<void>

  // ── node data layer (#61) ─────────────────────────────────────────────────
  // Every mapping change persists to node-mapping.json and also pushes `nodes:model`.
  /** Current model + telemetry, for a renderer (re)load. */
  getNodes(): Promise<NodeSnapshot>
  /** Rename / move / re-zone a registry or adopted node. A value equal to its default is cleared. */
  setNodeMapping(nodeId: number, patch: MappingPatch): Promise<NodeMappingResult>
  /** Place a new NODE_ID (not in the registry); it stops being "new". */
  adoptNode(nodeId: number, spec: AdoptSpec): Promise<NodeMappingResult>
  /** Drop an adopted node (new again if it reports) or a registry node's overrides. */
  forgetNode(nodeId: number): Promise<NodeMappingResult>
  /** Every registry node back to its defaults; adopted, ignored and hidden are kept. */
  resetNodeMapping(): Promise<NodeMappingResult>
  /** Ignore permanently (true) or un-ignore (false). */
  ignoreNode(nodeId: number, on: boolean): Promise<NodeMappingResult>
  /** "Hidden until it reports again" on / off. Cleared automatically when the node reports. */
  hideNode(nodeId: number, on: boolean): Promise<NodeMappingResult>
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

  // ── the client's copy of what the device confirmed storing (#46, part 5) ──
  /**
   * What the cache holds for the board currently attached, and which of its axes the device has
   * since lost. `board` is undefined when nothing is cached, or when the port reports no serial —
   * without one there is no way to tell this board's calibration from another's.
   */
  calCacheRead(): Promise<CalResult<{ board?: CachedBoard; regressed: number[] }>>
  /**
   * Record axes the device has **confirmed** storing — call after the read-back, never after the
   * ACK. Caching what was sent rather than what came back would preserve client optimism as if it
   * were device state, which is the one thing this copy must never do.
   */
  calCacheStore(axes: CalCacheEntry[]): Promise<CalResult<null>>
  /**
   * Forget an axis the user deliberately deleted, or the whole board with `0xFF`.
   *
   * A deletion has to reach the cache. Inferring it from a later read is impossible — an axis that
   * is uncalibrated because the user erased it looks exactly like one that lost its calibration,
   * and the client would offer to restore what was just deleted.
   */
  calCacheDrop(idx: number): Promise<CalResult<null>>
}

export interface NodeSnapshot {
  model: NodeModel
  telemetry: NodeTelemSnapshot[]
}

/** A mapping change: the new model, or why the input was refused (nothing was written). */
export type NodeMappingResult = { ok: true; model: NodeModel } | { ok: false; error: string }

/** One axis on its way into the cache: the confirmed values plus the setting the device cannot hold. */
export interface CalCacheEntry extends CachedAxis {
  idx: number
}
