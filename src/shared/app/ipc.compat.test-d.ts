// Compile-time guard on the renderer ↔ main API surface (arch-phase0-v2 §2.3, R1.3).
//
// A frozen copy of `SkyhawkApi`, `PushChannels`, `IPC` and `CTRL` as they stood before the IPC
// contract was split per topic. `npm run typecheck` fails if the live types drift from it: a
// method added, removed, renamed or re-typed, a push channel re-typed, a channel string changed.
// A later PR that changes the API on purpose updates the copy in the same diff.
//
// Type-only: never imported, never run, not matched by vitest (`*.test.ts`) or the build.
import type {
  AppConfig,
  CalCacheEntry,
  CalCommitAxis,
  CalHello,
  CalRawSample,
  CalResult,
  CalSnapshot,
  CaptureState,
  ConfigExportResult,
  ConfigImportApplyResult,
  ConfigImportOpen,
  DebugDumpResult,
  DeviceStatus,
  ExportResult,
  HidAvailability,
  HidSnapshot,
  LogRow,
  NodeMappingResult,
  NodeRegistryInfo,
  NodeSnapshot,
  RelayResult,
  RelayState,
  RelayStatus,
  ReplayLoad,
  SerialFrame,
  StatsSnapshot,
  AircraftStatus,
  TelemetryReadout
} from '@shared/ipc'
import type { CTRL, IPC, PushChannels, SkyhawkApi } from '@shared/ipc'
import type { CachedBoard } from '@shared/cal-cache'
import type { SectionId } from '@shared/config-file'
import type { LogEvent } from '@shared/events'
import type { NodeTelemSnapshot } from '@shared/node-telem'
import type { AdoptSpec, MappingPatch, ResetOptions, ResetPreview } from '@shared/node-mapping'
import type { NodeModel } from '@shared/node-rules'

/** Exact type equality (mutual assignability is not enough: it misses optional/readonly drift). */
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false
type Expect<T extends true> = T

interface OldPushChannels {
  'device:status': DeviceStatus
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
  'cal:raw': CalRawSample[]
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
  readonly calRaw: 'cal:raw'
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
  readonly calHello: 'cal:hello'
  readonly calRead: 'cal:read'
  readonly calSessionOpen: 'cal:session-open'
  readonly calStreamSelect: 'cal:stream-select'
  readonly calCommit: 'cal:commit'
  readonly calReset: 'cal:reset'
  readonly calSessionClose: 'cal:session-close'
  readonly calCacheRead: 'cal:cache-read'
  readonly calCacheStore: 'cal:cache-store'
  readonly calCacheDrop: 'cal:cache-drop'
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
  getStatus(): Promise<RelayStatus>
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
  setSerialMonitor(on: boolean): Promise<void>
  dumpSerialPorts(): Promise<DebugDumpResult>
  revealDebugLog(): Promise<void>
  calHello(): Promise<CalResult<CalHello>>
  calRead(): Promise<CalResult<CalSnapshot>>
  calSessionOpen(axisIdx: number): Promise<CalResult<{ timeoutMs: number; axisIdx: number }>>
  calStreamSelect(axisIdx: number): Promise<CalResult<null>>
  calCommit(axis: CalCommitAxis): Promise<CalResult<null>>
  calReset(idx: number): Promise<CalResult<null>>
  calSessionClose(): Promise<CalResult<null>>
  calCacheRead(): Promise<CalResult<{ board?: CachedBoard; regressed: number[] }>>
  calCacheStore(axes: CalCacheEntry[]): Promise<CalResult<null>>
  calCacheDrop(idx: number): Promise<CalResult<null>>
}

export type ApiSurfaceUnchanged = [
  Expect<Equal<OldSkyhawkApi, SkyhawkApi>>,
  Expect<Equal<OldPushChannels, PushChannels>>,
  Expect<Equal<OldIPC, typeof IPC>>,
  Expect<Equal<OldCTRL, typeof CTRL>>
]
