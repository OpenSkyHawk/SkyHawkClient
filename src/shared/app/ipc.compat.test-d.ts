// Compile-time guard on the renderer ↔ main API surface (arch-phase0-v2 §2.3, R1.3).
//
// A frozen copy of `SkyhawkApi`, `PushChannels`, `IPC` and `CTRL` as they stood before the IPC
// contract was split per topic. `npm run typecheck` fails if the live types drift from it: a
// method added, removed, renamed or re-typed, a push channel re-typed, a channel string changed.
// A later PR that changes the API on purpose updates the copy in the same diff.
//
// R3.1 (calibration workflow to main): the ten protocol intents (cal:hello … cal:cache-drop) left
// the API, the ten workflow intents (cal:open … cal:set-restore-open) and the lifecycle intent
// cal:attach joined it, `cal:raw` became
// main-internal, `cal:workflow` was added, and `relay:status`'s `cal` became the CalibrationState.
//
// R3.2a (cockpit snapshot to main): the push `cockpit:snapshot` → `CockpitSnapshot` was added.
// No intent and no method changed.
//
// R3.2b (cockpit snapshot for the Overview, Connection and Settings): the intents
// `node-mapping:add-all` (addAllNodes) and `node-mapping:unhide` (unhideNodes) → `NodeBatchResult`
// were added — the Adopt dialog's "Add all" and Settings' "Un-hide all" loops, now run in main.
// `CockpitSnapshot` gained its Overview, Connection and Settings sections (a type change only).
//
// R3.3 (link, relay, HID and settings rules pushed from main): `device:status` and the rehydrate
// bundle's `device` became `DeviceStatusPush` — the status plus what main concludes from it
// (linkUp, boardPresent, busy, linkDownAt, serialMonitor; additive fields). `hid:report` became
// `HidReport` — the report plus its band, present axis count and live axis slots (additive). The
// push `config:changed` → `ConfigChanged` was added (the settings after each change, and what the
// power supply resolves to), `config:get` answers `ConfigView` (the settings with the resolved
// power supply) instead of `AppConfig`, and the intent `config:edit` (editConfig) was added: a
// form's change, as typed, built into the save in main. The push `relay:facts` → `RelayFacts` was
// added (what the relay's surfaces show, decided in main) and the rehydrate bundle carries it
// (`relayFacts`); the intent `relay:toggle` (toggleRelay) was added: the pill's and the Start
// button's Stop-or-save-then-Start, run in main. `TelemetryReadout` gained `tone` (a type change
// only: the channel's name and payload type are the same).
//
// R3.4a (the last renderer decisions move to main): type changes only — no channel, intent or
// method was added, removed or renamed, so the frozen copy above still matches. `DeviceStatusPush`
// gained `action` (LinkAction: the device card's and popover's button) and `canRefresh`;
// `GatewayStatus` gained `aboutLink` (not responding is a link title); `RelayFacts` gained
// `recordShown`; `ConfigEdit` gained `psuMode`; `ConfigExportResult` became a union on `outcome`
// (`saved` with its path, `canceled`, `failed` with its error).
//
// R3.4c (one consistent frame per main update): the wire changed, the API did not. Main sends
// every push of one turn as one message on the new channel `push:batch` (PUSH_BATCH), carrying a
// `PushBatch` — an ordered list of `{ channel, payload }` over the push channels above — and the
// preload hands each push to the subscribers `on` registered, in order. So `SkyhawkApi`,
// `PushChannels`, `IPC` and `CTRL` still match the frozen copy; the wire channel and the batch's
// shape are pinned below. `RelayFacts` gained `mode` and `transport` (a type change only).
//
// R3.4d (final cleanup): the push `cal:data` (IPC.calData) was removed — the renderer stopped
// listening in R3.1, when the calibration workflow moved to main; main still reads GET_CAL and
// hands the report to the workflow, which pushes `cal:workflow`. The push `nodes:telemetry`
// (IPC.nodesTelemetry) was removed too: no renderer view read it since the Cockpit snapshot
// (R3.2); NodeHub still takes the PDU pages into that snapshot, and `nodes:get` still answers them. Two contract types were renamed
// with their shapes unchanged — `LogRow` → `StreamRow` (`log:batch`) and the DCS `CaptureState` →
// `RecordState` (`capture:toggle`); the frozen copies below pin both shapes under the old names.
//
// Type-only: never imported, never run, not matched by vitest (`*.test.ts`) or the build.
import type { Mutate, StoreApi } from 'zustand/vanilla'
import type {} from 'zustand/middleware' // registers the subscribeWithSelector store mutator
import type {
  AppConfig,
  ConfigChanged,
  ConfigEdit,
  ConfigExportResult,
  ConfigImportApplyResult,
  ConfigImportOpen,
  ConfigView,
  SectionId,
  SettingsStore
} from '../config/ipc'
import type { CalibrationState } from '../hid/calibration/ipc'
import type {
  AircraftStatus,
  ExportResult,
  RecordState,
  RelayFacts,
  RelayResult,
  RelayState,
  ReplayLoad,
  StatsSnapshot,
  StreamRow,
  TelemetryReadout
} from '../dcs/ipc'
import type {
  CTRL,
  DebugDumpResult,
  IPC,
  PUSH_BATCH,
  PushBatch,
  PushChannels,
  RelayStatus,
  SkyhawkApi
} from './ipc'
import type { DeviceStatusPush, SerialFrame } from '../gateway/ipc'
import type { HidAvailability, HidReport } from '../hid/ipc'
import type {
  AdoptRequest,
  AdoptSpec,
  CockpitSnapshot,
  MappingPatch,
  NodeBatchResult,
  NodeMappingResult,
  NodeModel,
  NodeRegistryInfo,
  NodeSnapshot,
  ResetOptions,
  ResetPreview
} from '../nodes/ipc'
import type { LogEvent } from '../events/ipc'

/** Exact type equality (mutual assignability is not enough: it misses optional/readonly drift). */
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false
type Expect<T extends true> = T

/** R3.4d: `StreamRow` as it stood when it was still called `LogRow`. */
interface OldLogRow {
  t: number
  dir: 'in' | 'out'
  address: number
  name?: string
  value: number | string
  raw?: string
}

/** R3.4d: `RecordState` as it stood when it was still called `CaptureState`. */
interface OldCaptureState {
  recording: boolean
  path?: string
  events?: number
}

interface OldRelayStatus {
  running: boolean
  relay: RelayState
  relayFacts: RelayFacts
  device: DeviceStatusPush
  cal?: CalibrationState
}

interface OldPushChannels {
  'device:status': DeviceStatusPush
  'relay:state': RelayState
  'aircraft:changed': AircraftStatus
  'stats:tick': StatsSnapshot
  'log:batch': OldLogRow[]
  'events:batch': LogEvent[]
  'hid:report': HidReport
  'telemetry:tick': TelemetryReadout[]
  'nodes:model': NodeModel
  'serial:traffic': SerialFrame[]
  'cal:workflow': CalibrationState
  'cockpit:snapshot': CockpitSnapshot
  'config:changed': ConfigChanged
  'relay:facts': RelayFacts
}

type OldPushChannel = keyof OldPushChannels

interface OldIPC {
  readonly deviceStatus: 'device:status'
  readonly relayState: 'relay:state'
  readonly aircraftChanged: 'aircraft:changed'
  readonly statsTick: 'stats:tick'
  readonly logBatch: 'log:batch'
  readonly eventsBatch: 'events:batch'
  readonly hidReport: 'hid:report'
  readonly telemetryTick: 'telemetry:tick'
  readonly nodesModel: 'nodes:model'
  readonly serialTraffic: 'serial:traffic'
  readonly calWorkflow: 'cal:workflow'
  readonly cockpitSnapshot: 'cockpit:snapshot'
  readonly configChanged: 'config:changed'
  readonly relayFacts: 'relay:facts'
}

interface OldCTRL {
  readonly configGet: 'config:get'
  readonly configSet: 'config:set'
  readonly configExport: 'config:export'
  readonly configImportOpen: 'config:import-open'
  readonly configImportApply: 'config:import-apply'
  readonly relayStart: 'relay:start'
  readonly relayStop: 'relay:stop'
  readonly relayStatus: 'relay:status'
  readonly deviceConnect: 'device:connect'
  readonly deviceDisconnect: 'device:disconnect'
  readonly logExport: 'log:export'
  readonly eventsGet: 'events:get'
  readonly eventsClear: 'events:clear'
  readonly eventsExport: 'events:export'
  readonly captureToggle: 'capture:toggle'
  readonly replayOpen: 'replay:open'
  readonly hidAvailability: 'hid:availability'
  readonly nodesRefresh: 'nodes:refresh'
  readonly nodesGet: 'nodes:get'
  readonly nodeMappingSet: 'node-mapping:set'
  readonly nodeMappingAdopt: 'node-mapping:adopt'
  readonly nodeMappingForget: 'node-mapping:forget'
  readonly nodeMappingResetNode: 'node-mapping:reset-node'
  readonly nodeMappingReset: 'node-mapping:reset'
  readonly nodeMappingResetPreview: 'node-mapping:reset-preview'
  readonly nodeRegistry: 'nodes:registry'
  readonly nodeMappingHide: 'node-mapping:hide'
  readonly serialMonitor: 'serial:monitor'
  readonly debugDumpPorts: 'debug:dump-ports'
  readonly debugReveal: 'debug:reveal'
  readonly calOpen: 'cal:open'
  readonly calClose: 'cal:close'
  readonly calSelectAxis: 'cal:select-axis'
  readonly calStartCapture: 'cal:start-capture'
  readonly calRetry: 'cal:retry'
  readonly calSetSelfCentring: 'cal:set-self-centring'
  readonly calSave: 'cal:save'
  readonly calRestore: 'cal:restore'
  readonly calDeleteAxis: 'cal:delete-axis'
  readonly calSetRestoreOpen: 'cal:set-restore-open'
  readonly calAttach: 'cal:attach'
  readonly nodeMappingAddAll: 'node-mapping:add-all'
  readonly nodeMappingUnhide: 'node-mapping:unhide'
  readonly configEdit: 'config:edit'
  readonly relayToggle: 'relay:toggle'
}

interface OldSkyhawkApi {
  on<C extends OldPushChannel>(channel: C, cb: (data: OldPushChannels[C]) => void): () => void
  getConfig(): Promise<ConfigView>
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>
  editConfig(edit: ConfigEdit): Promise<AppConfig>
  exportConfig(): Promise<ConfigExportResult>
  openConfigImport(): Promise<ConfigImportOpen>
  applyConfigImport(
    token: string,
    sections: SectionId[],
    backup: boolean
  ): Promise<ConfigImportApplyResult>
  startRelay(): Promise<RelayResult>
  stopRelay(): Promise<RelayResult>
  toggleRelay(relaying: boolean): Promise<RelayResult>
  getStatus(): Promise<OldRelayStatus>
  connectDevice(): Promise<void>
  disconnectDevice(): Promise<void>
  exportLog(text: string): Promise<ExportResult>
  getEvents(): Promise<LogEvent[]>
  clearEvents(): Promise<void>
  exportEvents(): Promise<ExportResult>
  toggleCapture(): Promise<OldCaptureState>
  openReplay(): Promise<ReplayLoad>
  getHidAvailability(): Promise<HidAvailability>
  refreshNodes(): Promise<void>
  getNodes(): Promise<NodeSnapshot>
  setNodeMapping(nodeId: number, patch: MappingPatch): Promise<NodeMappingResult>
  adoptNode(nodeId: number, spec: AdoptSpec): Promise<NodeMappingResult>
  forgetNode(nodeId: number): Promise<NodeMappingResult>
  resetNode(nodeId: number): Promise<NodeMappingResult>
  resetNodeMapping(opts?: ResetOptions): Promise<NodeMappingResult>
  previewNodeReset(): Promise<ResetPreview>
  getNodeRegistry(): Promise<NodeRegistryInfo>
  hideNode(nodeId: number, on: boolean): Promise<NodeMappingResult>
  addAllNodes(bulk: AdoptRequest[]): Promise<NodeBatchResult>
  unhideNodes(nodeIds: number[]): Promise<NodeBatchResult>
  setSerialMonitor(on: boolean): Promise<void>
  dumpSerialPorts(): Promise<DebugDumpResult>
  revealDebugLog(): Promise<void>
  calOpen(axis: number, review?: boolean): Promise<void>
  calClose(): Promise<void>
  calSelectAxis(axis: number): Promise<void>
  calStartCapture(): Promise<void>
  calRetry(): Promise<void>
  calSetSelfCentring(selfCentring: boolean): Promise<void>
  calSave(): Promise<void>
  calRestore(): Promise<void>
  calDeleteAxis(idx: number): Promise<void>
  calSetRestoreOpen(open: boolean): Promise<void>
  calAttach(on: boolean): Promise<void>
}

/** R3.4c: one `push:batch` message — main's pushes of one turn, in order. */
type OldPushBatch = {
  [C in OldPushChannel]: { channel: C; payload: OldPushChannels[C] }
}[OldPushChannel][]

export type ApiSurfaceUnchanged = [
  Expect<Equal<OldSkyhawkApi, SkyhawkApi>>,
  Expect<Equal<OldPushChannels, PushChannels>>,
  Expect<Equal<OldIPC, typeof IPC>>,
  Expect<Equal<OldCTRL, typeof CTRL>>,
  Expect<Equal<OldRelayStatus, RelayStatus>>,
  Expect<Equal<'push:batch', typeof PUSH_BATCH>>,
  Expect<Equal<OldPushBatch, PushBatch>>
]

/** R3.4d: the renames changed names only. */
export type RenamedShapesUnchanged = [
  Expect<Equal<OldLogRow, StreamRow>>,
  Expect<Equal<OldCaptureState, RecordState>>
]

/**
 * `SettingsStore` is type-only, but a zustand vanilla store under `subscribeWithSelector` must be
 * usable as one (R2.3 hands such a store out).
 */
type ZustandSettingsStore = Mutate<StoreApi<AppConfig>, [['zustand/subscribeWithSelector', never]]>
export type SettingsStoreFitsZustand = Expect<
  ZustandSettingsStore extends SettingsStore ? true : false
>
