// Typed IPC contract between the Electron main process and the renderer.
// Channels are one-way main -> renderer pushes; control actions are renderer -> main.
//
// The app contract assembles the topic contracts (shared/<topic>/ipc.ts) into the one surface the
// preload exposes: `SkyhawkApi`, every push channel and every intent channel. It owns only what
// spans topics: the `relay:status` rehydrate bundle and the debug intents.
import {
  CONFIG_CTRL,
  CONFIG_PUSH,
  type AppConfig,
  type BackupList,
  type ConfigEdit,
  type ConfigEditResult,
  type ConfigPushChannels,
  type ConfigView,
  type ConfigExportResult,
  type ConfigImportApplyResult,
  type ConfigImportOpen,
  type SectionId
} from '../config/ipc'
import {
  DCS_CTRL,
  DCS_PUSH,
  type AircraftStatus,
  type DcsPushChannels,
  type ExportResult,
  type RecordState,
  type RelayFacts,
  type RelayResult,
  type RelayState,
  type ReplayLoad,
  type TelemetryReadout
} from '../dcs/ipc'
import { EVENTS_CTRL, EVENTS_PUSH, type EventsPushChannels, type LogEvent } from '../events/ipc'
import {
  GATEWAY_CTRL,
  GATEWAY_PUSH,
  type DeviceStatusPush,
  type GatewayPushChannels
} from '../gateway/ipc'
import { HID_CTRL, HID_PUSH, type HidAvailability, type HidPushChannels } from '../hid/ipc'
import {
  CALIBRATION_CTRL,
  CALIBRATION_PUSH,
  type CalibrationPushChannels,
  type CalibrationState
} from '../hid/calibration/ipc'
import {
  NODES_CTRL,
  NODES_PUSH,
  type AdoptRequest,
  type AdoptSpec,
  type MappingPatch,
  type NodeBatchResult,
  type NodeMappingResult,
  type NodeRegistryInfo,
  type NodeSnapshot,
  type NodesPushChannels,
  type ResetOptions,
  type ResetPreview
} from '../nodes/ipc'

/** Live session state so a freshly (re)loaded renderer can rehydrate. */
export interface RelayStatus {
  running: boolean
  relay: RelayState
  /**
   * What the relay's surfaces show, as `relay:facts` carries it (R3.3): the recording and the
   * loaded capture included, as main holds them (N1).
   */
  relayFacts: RelayFacts
  /** The aircraft as `aircraft:changed` last carried it (N1); pushed only when it changes. */
  aircraft: AircraftStatus
  /** The gauges as the last `telemetry:tick` carried them, relaying or not (N1). */
  telemetry: TelemetryReadout[]
  /**
   * The link, with what main concludes from it, as `device:status` carries it (R3.3): the
   * serial monitor's flag and the last-known time included (N1).
   */
  device: DeviceStatusPush
  /**
   * The calibration workflow's last `cal:workflow` push: the device's last report (if the link is
   * still up), the badges and the restore offer, and the dialog if it is open.
   *
   * Carried here because the report is only pushed when the port opens. A renderer reload
   * creates a fresh store while the main-process session keeps running, so without this the
   * badges would stay blank until the next reconnect — indefinitely, on a stable link.
   */
  cal?: CalibrationState
}

export interface DebugDumpResult {
  path: string
  count: number
}

// main -> renderer channel payloads
//
// Two scopes (#69). **Link-scoped** pushes flow whenever the device link is up, relaying or not:
// device:status, nodes:*, serial:traffic. On link down they stop and the renderer keeps
// the last state, dimmed while device:status says the link is down. hid:report is neither: the joystick is read for as long
// as the app runs, serial port open or not; nor is cal:workflow, which follows the link's state
// and the dialog's actions, nor relay:facts, config:changed and config:backups, which follow what
// they are about.
// **Relay-scoped** pushes flow only while
// relaying: relay:state changes, aircraft:changed, stats:tick, telemetry:tick. log:batch carries
// both (panel commands are logged while stopped too), and so does events:batch.
// Each topic declares its own pushes (shared/<topic>/ipc.ts); this is their union.
export interface PushChannels
  extends
    GatewayPushChannels,
    DcsPushChannels,
    EventsPushChannels,
    HidPushChannels,
    NodesPushChannels,
    CalibrationPushChannels,
    ConfigPushChannels {}

export type PushChannel = keyof PushChannels

/** One push, as it travels inside a `push:batch` message: its channel and that channel's payload. */
export type PushItem = {
  [C in PushChannel]: { channel: C; payload: PushChannels[C] }
}[PushChannel]

/**
 * Every push main made in one turn of its event loop, in the order it made them (R3.4c). A link
 * change fans out `device:status`, `cal:workflow`, `cockpit:snapshot` and `relay:facts` from one
 * handler; sent as one message, the renderer applies them in one task and draws them as one frame.
 */
export type PushBatch = PushItem[]

/**
 * The one wire channel main → renderer pushes travel on since R3.4c: each message is a PushBatch.
 * The push channels above stay the names the renderer subscribes to and routes by.
 */
export const PUSH_BATCH = 'push:batch'

/**
 * Hand each push of a batch to its channel's subscribers, in the batch's order: the preload's
 * dispatch of one `push:batch` message (and the renderer test mock's). One call, one task.
 *
 * A subscriber that throws costs only its own push, as when each push was its own message: the
 * pushes after it are still delivered, and the error is rethrown once the batch is through.
 */
export function deliverPushes(
  batch: PushBatch,
  subscribers: (channel: PushChannel) => Iterable<(payload: never) => void> | undefined
): void {
  const errors: unknown[] = []
  for (const { channel, payload } of batch) {
    try {
      for (const cb of subscribers(channel) ?? []) (cb as (p: typeof payload) => void)(payload)
    } catch (e) {
      errors.push(e)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'push subscribers threw')
}

/**
 * A main → renderer push, as AppServices hands it to each service. `Emit<C>` narrows it to some
 * channels (EventJournal pushes only `events:batch`); the full `Emit` is assignable to any of them.
 */
export type Emit<Channels extends PushChannel = PushChannel> = <C extends Channels>(
  channel: C,
  payload: PushChannels[C]
) => void

export const IPC = {
  ...GATEWAY_PUSH,
  ...DCS_PUSH,
  ...EVENTS_PUSH,
  ...HID_PUSH,
  ...NODES_PUSH,
  ...CALIBRATION_PUSH,
  ...CONFIG_PUSH
} as const

/** Intents this contract owns: the rehydrate bundle and the debug-log tools. */
export const APP_CTRL = {
  relayStatus: 'relay:status',
  debugDumpPorts: 'debug:dump-ports',
  debugReveal: 'debug:reveal'
} as const

// ── control (renderer -> main, invoke/response) ──────────────────────────────

export const CTRL = {
  ...CONFIG_CTRL,
  ...DCS_CTRL,
  ...APP_CTRL,
  ...GATEWAY_CTRL,
  ...EVENTS_CTRL,
  ...HID_CTRL,
  ...NODES_CTRL,
  ...CALIBRATION_CTRL
} as const

/** An intent channel: any CTRL value. */
export type CtrlChannel = (typeof CTRL)[keyof typeof CTRL]

/** An intent's handler, as `ipcMain.handle` takes it. Each handler types its own arguments. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ipcMain's own listener shape
export type IpcListener = (event: unknown, ...args: any[]) => unknown

/**
 * Where main answers intents: `ipcMain.handle`, structurally, so a main topic's
 * `register<Topic>Ipc` never imports electron (only main/app does).
 */
export interface IpcRegistrar {
  handle(channel: CtrlChannel, listener: IpcListener): void
}

/** The contextBridge surface exposed to the renderer as `window.skyhawk`. */
export interface SkyhawkApi {
  on<C extends PushChannel>(channel: C, cb: (data: PushChannels[C]) => void): () => void
  /** The settings and what they resolve to (the power supply). */
  getConfig(): Promise<ConfigView>
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>
  /**
   * A form's change, as typed (R3.3): main builds the save over what it holds and pushes
   * `config:changed`, or refuses it (nothing saved) and answers why (N5).
   */
  editConfig(edit: ConfigEdit): Promise<ConfigEditResult>

  // ── configuration export / import (#67) ──────────────────────────────────
  /** Save dialog, then write every section to one file. */
  exportConfig(): Promise<ConfigExportResult>
  /** Open dialog, then validate and preview; the file stays in main until applied. */
  openConfigImport(): Promise<ConfigImportOpen>
  /** Apply the picked sections of the previewed file, after an optional backup of the current setup. */
  applyConfigImport(
    token: string,
    sections: SectionId[],
    backup: boolean
  ): Promise<ConfigImportApplyResult>
  /** The automatic backups, newest first (main pushes `config:backups` when they change). */
  getConfigBackups(): Promise<BackupList>
  /**
   * Read one automatic backup (its name in the list) and preview it as an import: the same review
   * and apply, the answer's `preview.backup` saying it is a restore.
   */
  openConfigBackup(file: string): Promise<ConfigImportOpen>
  /** Open the backups folder in the file manager (Finder, Explorer, …). */
  revealConfigBackups(): Promise<void>
  startRelay(): Promise<RelayResult>
  stopRelay(): Promise<RelayResult>
  /**
   * The Relay pill and the Start / Stop button (R3.3): Stop if `relaying` (what the renderer
   * shows), else save the settings and Start — main's answer to Start, refused or not.
   */
  toggleRelay(relaying: boolean): Promise<RelayResult>
  getStatus(): Promise<RelayStatus>
  /** Open the device link now, whatever "connect automatically" says. */
  connectDevice(): Promise<void>
  /** Close the device link and keep it closed — through a replug — until connectDevice(). */
  disconnectDevice(): Promise<void>
  /**
   * Read the Gateway's link health again (#169): GET_DIAG while the link is up. The answer comes
   * on `device:status` (`linkHealth`), not here.
   */
  refreshGatewayDiag(): Promise<void>
  exportLog(text: string): Promise<ExportResult>

  // ── event log (#64) — in memory in main, this app run only ────────────────
  /** Every event this session, oldest first, for a renderer (re)load. */
  getEvents(): Promise<LogEvent[]>
  /** Clear the session's events (what Clear in Log › Events does). */
  clearEvents(): Promise<void>
  /** Save dialog, then every event as TSV, oldest first, whatever the view filters. */
  exportEvents(): Promise<ExportResult>
  toggleCapture(): Promise<RecordState>
  openReplay(): Promise<ReplayLoad>
  getHidAvailability(): Promise<HidAvailability>

  // ── node data layer (#61) ─────────────────────────────────────────────────
  // Every mapping change persists to node-mapping.json and also pushes `nodes:model`.
  /** Current model + telemetry, for a renderer (re)load. */
  getNodes(): Promise<NodeSnapshot>
  /** Rename / move / re-zone a registry or adopted node. A value equal to its default is cleared. */
  setNodeMapping(nodeId: number, patch: MappingPatch): Promise<NodeMappingResult>
  /** Place a new NODE_ID (not in the registry); it stops being "new". */
  adoptNode(nodeId: number, spec: AdoptSpec): Promise<NodeMappingResult>
  /**
   * Remove an offline board from your cockpit, keeping nothing; forgetting a PDU unlinks its
   * boards. Refused while the board is online.
   */
  forgetNode(nodeId: number): Promise<NodeMappingResult>
  /** One registry board back to its NODE_IDS.md name, console and power zone. */
  resetNode(nodeId: number): Promise<NodeMappingResult>
  /**
   * Every registry node back to its defaults; hidden flags and last-seen times are kept, and
   * adopted nodes too unless `forgetAdopted`.
   */
  resetNodeMapping(opts?: ResetOptions): Promise<NodeMappingResult>
  /** What resetNodeMapping would change, field by field — the review before a reset. */
  previewNodeReset(): Promise<ResetPreview>
  /** The bundled NODE_IDS registry (PanelBridge included) and the commit it came from. */
  getNodeRegistry(): Promise<NodeRegistryInfo>
  /**
   * "Hidden until it reports again" on / off. Cleared automatically when the node reports; turning
   * it on is refused while the board is online.
   */
  hideNode(nodeId: number, on: boolean): Promise<NodeMappingResult>
  /**
   * "Add all": adopt each board in turn, as `adoptNode` would, stopping at the first refusal. Each
   * one pushes `nodes:model` as it lands.
   */
  addAllNodes(bulk: AdoptRequest[]): Promise<NodeBatchResult>
  /** Un-hide each board in turn, as `hideNode(id, false)` would, stopping at the first refusal. */
  unhideNodes(nodeIds: number[]): Promise<NodeBatchResult>
  setSerialMonitor(on: boolean): Promise<void>
  dumpSerialPorts(): Promise<DebugDumpResult>
  revealDebugLog(): Promise<void>

  // ── axis calibration (#46) ────────────────────────────────────────────────
  // The dialog's actions. Main runs the workflow — the protocol exchanges, the restore cache —
  // and answers each by pushing `cal:workflow`.
  /** Open the dialog on `axis`: a session first, then the dialog. `review` expands the restore offer. */
  calOpen(axis: number, review?: boolean): Promise<void>
  /** Close the session and the dialog, then re-read what the device holds. */
  calClose(): Promise<void>
  /** Show and stream another axis; drafts survive the switch. */
  calSelectAxis(axis: number): Promise<void>
  calStartCapture(): Promise<void>
  /** Redo a rejected sweep, keeping the accepted ones. */
  calRetry(): Promise<void>
  /** The rest-position setting for the axis on screen. */
  calSetSelfCentring(selfCentring: boolean): Promise<void>
  /** Write every edited axis, each verified by a read-back. */
  calSave(): Promise<void>
  /** Write the cached copy back for the axes the device has lost. */
  calRestore(): Promise<void>
  /** Delete stored calibration for one axis. Persists immediately. */
  calDeleteAxis(idx: number): Promise<void>
  /** Expand or fold the restore offer. */
  calSetRestoreOpen(open: boolean): Promise<void>
  /**
   * The HID tab mounted (`true`) or unmounted (`false`): main builds the calibration workflow for
   * the view, or disposes it.
   */
  calAttach(on: boolean): Promise<void>
}
