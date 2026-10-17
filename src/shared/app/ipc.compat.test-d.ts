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
// (linkUp, boardPresent, busy, linkDownAt, serialMonitor; additive fields).
//
// Type-only: never imported, never run, not matched by vitest (`*.test.ts`) or the build.
import type { Mutate, StoreApi } from 'zustand/vanilla'
import type {} from 'zustand/middleware' // registers the subscribeWithSelector store mutator
import type {
  AppConfig,
  ConfigExportResult,
  ConfigImportApplyResult,
  ConfigImportOpen,
  SectionId,
  SettingsStore
} from '../config/ipc'
import type { CalibrationState, CalSnapshot } from '../hid/calibration/ipc'
import type {
  AircraftStatus,
  CaptureState,
  ExportResult,
  LogRow,
  RelayResult,
  RelayState,
  ReplayLoad,
  StatsSnapshot,
  TelemetryReadout
} from '../dcs/ipc'
import type { CTRL, DebugDumpResult, IPC, PushChannels, RelayStatus, SkyhawkApi } from './ipc'
import type { DeviceStatusPush, SerialFrame } from '../gateway/ipc'
import type { HidAvailability, HidSnapshot } from '../hid/ipc'
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
  NodeTelemSnapshot,
  ResetOptions,
  ResetPreview
} from '../nodes/ipc'
import type { LogEvent } from '../events/ipc'

/** Exact type equality (mutual assignability is not enough: it misses optional/readonly drift). */
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false
type Expect<T extends true> = T

interface OldRelayStatus {
  running: boolean
  relay: RelayState
  device: DeviceStatusPush
  cal?: CalibrationState
}

interface OldPushChannels {
  'device:status': DeviceStatusPush
  'relay:state': RelayState
  'aircraft:changed': AircraftStatus
  'stats:tick': StatsSnapshot
  'log:batch': LogRow[]
  'events:batch': LogEvent[]
  'hid:report': HidSnapshot
  'telemetry:tick': TelemetryReadout[]
  'nodes:telemetry': NodeTelemSnapshot[]
  'nodes:model': NodeModel
  'serial:traffic': SerialFrame[]
  'cal:data': CalSnapshot
  'cal:workflow': CalibrationState
  'cockpit:snapshot': CockpitSnapshot
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
  readonly nodesTelemetry: 'nodes:telemetry'
  readonly nodesModel: 'nodes:model'
  readonly serialTraffic: 'serial:traffic'
  readonly calData: 'cal:data'
  readonly calWorkflow: 'cal:workflow'
  readonly cockpitSnapshot: 'cockpit:snapshot'
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
}

interface OldSkyhawkApi {
  on<C extends OldPushChannel>(channel: C, cb: (data: OldPushChannels[C]) => void): () => void
  getConfig(): Promise<AppConfig>
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>
  exportConfig(): Promise<ConfigExportResult>
  openConfigImport(): Promise<ConfigImportOpen>
  applyConfigImport(
    token: string,
    sections: SectionId[],
    backup: boolean
  ): Promise<ConfigImportApplyResult>
  startRelay(): Promise<RelayResult>
  stopRelay(): Promise<RelayResult>
  getStatus(): Promise<OldRelayStatus>
  connectDevice(): Promise<void>
  disconnectDevice(): Promise<void>
  exportLog(text: string): Promise<ExportResult>
  getEvents(): Promise<LogEvent[]>
  clearEvents(): Promise<void>
  exportEvents(): Promise<ExportResult>
  toggleCapture(): Promise<CaptureState>
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

export type ApiSurfaceUnchanged = [
  Expect<Equal<OldSkyhawkApi, SkyhawkApi>>,
  Expect<Equal<OldPushChannels, PushChannels>>,
  Expect<Equal<OldIPC, typeof IPC>>,
  Expect<Equal<OldCTRL, typeof CTRL>>,
  Expect<Equal<OldRelayStatus, RelayStatus>>
]

/**
 * `SettingsStore` is type-only, but a zustand vanilla store under `subscribeWithSelector` must be
 * usable as one (R2.3 hands such a store out).
 */
type ZustandSettingsStore = Mutate<StoreApi<AppConfig>, [['zustand/subscribeWithSelector', never]]>
export type SettingsStoreFitsZustand = Expect<
  ZustandSettingsStore extends SettingsStore ? true : false
>
