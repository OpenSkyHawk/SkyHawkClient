// Nodes topic contract (arch-phase0-v2 §2.3): the CAN node roster, PDU telemetry, the node mapping
// and the PSU limits the Cockpit draws against. Imported by main, preload and the renderer.
import type { TELEM_PAGES } from '../firmware'

export interface NodeStatus {
  nodeId: number // 0 = the bridge's own row (v3), 1..MAX_NODE_ID CAN nodes
  present: boolean
  boff: boolean // CAN bus-off
  epvf: boolean // CAN error-passive
  uptimeSec: number // wraps ~18 h
  rxCount: number // node-accepted CAN RX count
  tec: number // transmit error counter (esr low byte)
  rec: number // receive error counter (esr high byte)
  // HEALTH_n telemetry (proto v2). Uncalibrated internal MCU sensor — die temp, not ambient.
  dieTempC: number | null // whole °C; null = not yet seen (DIE_TEMP_UNAVAILABLE, 0x80 on the wire)
  overheat: boolean // hFlags bit0 (opt-in firmware trip; usually false)
  degraded: boolean // hFlags bit1 — a registered FaultSource reports non-NONE (rendered by #40, parsed here)
  faultId: number // fault code, 0 = none; label via NODE_FAULT_CODES (node-status.generated.ts), render #40
  /** NODE_KIND as the board reports it (v3); 0 = not reported yet (or pre-#344 firmware). Kept raw: an
   * unknown future value passes through and is never adoptable. */
  nodeKind: number
  // Fault-dictionary enrichment — filled in main from NODE_FAULT_CODES; undefined when healthy or an
  // unknown/reserved id (the decoder passes any faultId through). Renderer falls back to `Fault N`.
  faultAbbr?: string
  faultLabel?: string
  faultDesc?: string
}

/** When a node was first seen and, while it is offline, when and how it went offline. */
export interface NodeSeen {
  firstSeenAt: number
  /** When its latest status row arrived while it was present — what "updated N s ago" counts from. */
  reportedAt?: number
  /** Set while offline: when the client learned of it. */
  offlineAt?: number
  /**
   * 'delta' = a live `_NODE_STATUS` pushed on the transition (arrives ~3 s after the node goes
   * silent, the bridge's heartbeat timeout). 'roster' = found by a roster reply, so the real
   * transition happened up to one poll earlier.
   */
  offlineVia?: 'delta' | 'roster'
}

/**
 * A node's type once something solid says so. 'bridge' = a SimGateway/PanelBridge board; 'other' =
 * a kind this client doesn't know (a newer firmware's). Neither is ever adoptable.
 */
export type NodeIdentity = 'pdu' | 'panel' | 'bridge' | 'other'

export type NodeKind = 'pdu' | 'panel'

/** What node-mapping.json holds for one NODE_ID. Every field optional: absent = default. */
export interface NodeOverride {
  name?: string
  console?: string
  /** Power zone: the PDU NODE_ID feeding this node. null = explicitly none. */
  pduId?: number | null
  /** Adopted nodes only — registry nodes take their kind from the registry. */
  kind?: NodeKind
  /** Replaced / removed board: skip it until it reports again. */
  hidden?: boolean
  /**
   * Registry boards only: you added it to your cockpit (New on the bus › Add to cockpit). Reset to
   * default keeps it; only Forget removes it. Adopted nodes are in your cockpit by being adopted.
   */
  added?: boolean
  /**
   * When it was last on the bus, ISO 8601: written for a board in your cockpit when it comes
   * online, when it drops and when the link closes.
   */
  lastSeen?: string
}

export interface NodeMappingFile {
  version: 3
  nodes: Record<number, NodeOverride>
}

/** Effective defaults for one registry node. */
export interface NodeDefaults {
  name: string
  console: string
  pduId: number | null
  kind: NodeKind
}

/** A node as the client should present it: registry defaults with overrides applied. */
export interface MappedNode {
  nodeId: number
  name: string
  console: string
  pduId: number | null
  kind: NodeKind
  source: 'registry' | 'adopted'
  /** Registry node with at least one stored override (what reset would undo). */
  differs: boolean
  hidden: boolean
  /**
   * In your cockpit: adopted, or a registry board you added. A registry board that was never added
   * is only a dictionary entry — when it reports it waits in New on the bus, pre-filled.
   */
  known: boolean
  lastSeen?: string
}

export type MappingPatch = Partial<Pick<NodeOverride, 'name' | 'console' | 'pduId'>>
export interface AdoptSpec {
  name: string
  console: string
  pduId: number | null
  kind: NodeKind
}

export interface ResetOptions {
  /** Also drop every adopted node: each is "new" again the next time it reports. */
  forgetAdopted?: boolean
}

/** One field a reset would change, ready to show as `node · field  from → to`. */
export interface ResetRow {
  nodeId: number
  /** The node's registry name (what it is called after the reset). */
  node: string
  field: 'name' | 'console' | 'power zone'
  from: string
  to: string
}

/** An adopted node "Also forget adopted nodes" would drop. */
export interface AdoptedRow {
  nodeId: number
  name: string
  console: string
  /** Power zone as shown: the PDU's effective name, or '—'. */
  zone: string
}

export interface ResetPreview {
  rows: ResetRow[]
  /** Registry nodes the reset changes; equals `differingCount`. */
  nodeCount: number
  adopted: AdoptedRow[]
}

/**
 * PDU_RAIL_12V / PDU_RAIL_5V. Averages and the minimum cover the window since this page's
 * previous PERIODIC send (3 s). A flag-change send goes out at once without restarting that
 * window, so the next periodic page still covers the full 3 s.
 */
export interface PduRailPage {
  kind: 'rail'
  page: typeof TELEM_PAGES.PDU_RAIL_12V | typeof TELEM_PAGES.PDU_RAIL_5V
  flags: number // RAIL_FLAG bits
  vAvgMv: number
  vMinMv: number // window minimum
  /** Signed: a small negative value is residual sensor offset. Use displayCurrentMa() to show it. */
  iAvgMa: number
}

/** PDU_STATUS. */
export interface PduStatusPage {
  kind: 'status'
  page: typeof TELEM_PAGES.PDU_STATUS
  flags: number // PDU_FLAG bits
  /** Board NTC temperature, °C at 0.1 resolution; null = the board reports it unavailable. */
  ntcTempC: number | null
  /** 12 V peak current over the same window as the rail averages, after the board's ~100 µs RC filter. */
  i12PeakMa: number
  /** 5 V peak current, same window and filter. */
  i5PeakMa: number
}

/** A page id this build does not know (a newer node type). Kept raw; never decoded. */
export interface UnknownTelemPage {
  kind: 'unknown'
  page: number
  /** Frame bytes 1–7 as 14 hex chars, wire order. */
  body: string
}

export type TelemPageData = PduRailPage | PduStatusPage | UnknownTelemPage
export type NodeTelem = { nodeId: number } & TelemPageData

/** A page as last received, with its age. A stale page keeps its last values for "last known". */
export type TelemPageView<T extends TelemPageData> = T & { ageMs: number; stale: boolean }

export interface NodeTelemSnapshot {
  nodeId: number
  /** Has sent at least one PDU page since the store was reset. */
  isPdu: boolean
  rail12V?: TelemPageView<PduRailPage>
  rail5V?: TelemPageView<PduRailPage>
  status?: TelemPageView<PduStatusPage>
  /** Pages with ids this build does not know, by page id. */
  other: TelemPageView<UnknownTelemPage>[]
  /** At least one page is fresh (≤ TELEM_STALE_MS). */
  live: boolean
}

/** 'unknown' = no complete roster yet and the node has not reported — no data, not a state. */
export type NodeAvailability = 'online' | 'offline' | 'unknown'

export interface NodeModelEntry {
  nodeId: number
  /** Effective name; for a new node its NODE_IDS.md name, else `Node <id>`. */
  name: string
  /** null for a new node. */
  console: string | null
  /** null for a PDU: a PDU is never fed by another one, whatever was stored. */
  pduId: number | null
  /** For drawing: 'pdu' once identified as one, else 'panel'. Never stored, never a gate. */
  kind: NodeKind
  /**
   * What the node is, from the strongest signal (node-kind.ts resolveKind); undefined = not known
   * yet. Adopt, the new-device counts and the event log key on this, never on `kind`.
   */
  identified?: NodeIdentity
  /**
   * 'new' = on the bus but not in your cockpit: a NODE_ID the registry does not know, or a registry
   * board not added yet (#93: it waits in New on the bus, pre-filled from `registry`).
   */
  source: 'registry' | 'adopted' | 'new'
  /**
   * New registry boards: their NODE_IDS.md defaults, to pre-fill the Adopt form once the board has
   * identified itself. Never used to identify it.
   */
  registry?: { name: string; console: string; pduId: number | null; pduName?: string }
  availability: NodeAvailability
  /** While offline this session: when the client learned of it. Absent for `notSeen`. */
  offlineAt?: number
  offlineVia?: 'delta' | 'roster'
  /**
   * A board remembered from an earlier session (#93) that the bridge has not listed since the link
   * opened: offline, but not since any time this session knows — `lastSeenAt` says when it was.
   */
  notSeen?: boolean
  /** When it was last on the bus, from node-mapping.json (any session); absent if never recorded. */
  lastSeenAt?: number
  /** Last roster entry, when the node has ever reported. */
  status?: NodeStatus
  /** When `status` last arrived while the node was present (this session). */
  reportedAt?: number
  /** New nodes: when this session first saw it. Not persisted. */
  firstSeenAt?: number
  /** Online PDUs: 'none' = status but no fresh telemetry (never, or > TELEM_STALE_MS). */
  readings?: 'live' | 'none'
  /** PDUs: telemetry has arrived at least once since the session started. */
  everHadReadings?: boolean
  /** Registry node with overrides. */
  differs: boolean
}

/** A PDU and most of the nodes it feeds went offline together — one event, not N. */
export interface PduOutage {
  pduId: number
  /** The fed nodes that dropped with it. */
  nodeIds: number[]
  /** Fed nodes in total (excluding hidden ones and ones not seen this session), for "N of M". */
  fedCount: number
  at: number
}

/** One hidden node, as Settings › Hidden nodes lists it: what the Cockpit called it. */
export interface HiddenNode {
  nodeId: number
  /** Effective name: the user's own (renamed or adopted), else the registry's. */
  name: string
  /** Effective console; '' for an adopted node placed nowhere. */
  console: string
}

export interface NodeModel {
  nodes: NodeModelEntry[]
  outages: PduOutage[]
  /** Registry nodes that differ from their defaults (what "Reset all" changes). */
  differingCount: number
  /** Hidden until they report again — left out of `nodes`. */
  hidden: number[]
  /** The same ids with the name and console the Cockpit showed (the hidden nodes are not in `nodes`). */
  hiddenNodes: HiddenNode[]
  /**
   * The first complete roster since the session started has arrived. Stays false when PanelBridge
   * never ends a roster reply (node status not built into its firmware): registry nodes then stay
   * 'unknown', since there is no roster to be missing from.
   */
  rosterComplete: boolean
}

/** Rail limits as printed on a PSU label. Absent = unknown: the Cockpit shows plain totals. */
export interface PsuLimits {
  /** Combined current of all 12 V outputs, A. */
  a12?: number
  /** Combined current of all 5 V outputs, A. */
  a5?: number
  /** Rated output, W. */
  w?: number
}

export type PsuPresetId = 'nx650'

export interface PsuPreset {
  /** Short label for the segmented control. */
  label: string
  /** Full name, shown under the limits. */
  name: string
  limits: PsuLimits
}

export interface PsuSetting {
  mode: 'preset' | 'custom'
  preset: PsuPresetId
  /** Kept while a preset is picked, so switching back to Custom restores what was entered. */
  custom: PsuLimits
}

export const DEFAULT_PSU: PsuSetting = { mode: 'preset', preset: 'nx650', custom: {} }

export interface NodeRegistryInfo {
  /** Path in the firmware repo, e.g. Firmware/NODE_IDS.md. */
  file: string
  commit: string
  /** The commit's date, YYYY-MM-DD. */
  date: string
  nodes: { nodeId: number; name: string; console: string; kind: NodeKind | 'bridge' }[]
}

export interface NodeSnapshot {
  model: NodeModel
  telemetry: NodeTelemSnapshot[]
}

/** A mapping change: the new model, or why the input was refused (nothing was written). */
export type NodeMappingResult = { ok: true; model: NodeModel } | { ok: false; error: string }

/** This topic's main -> renderer pushes; shared/app assembles them into `PushChannels`. */
export interface NodesPushChannels {
  /** Latest PDU telemetry per node (#61). At most once a second, and only on change. */
  'nodes:telemetry': NodeTelemSnapshot[]
  /** Roster + telemetry + node mapping combined: what the Cockpit tab shows (#61, UI in #63). */
  'nodes:model': NodeModel
}

/** Push channel names (main -> renderer). */
export const NODES_PUSH = {
  nodesTelemetry: 'nodes:telemetry',
  nodesModel: 'nodes:model'
} as const

/** Intent channel names (renderer -> main, invoke/response). */
export const NODES_CTRL = {
  nodesRefresh: 'nodes:refresh',
  nodesGet: 'nodes:get',
  nodeMappingSet: 'node-mapping:set',
  nodeMappingAdopt: 'node-mapping:adopt',
  nodeMappingForget: 'node-mapping:forget',
  nodeMappingResetNode: 'node-mapping:reset-node',
  nodeMappingReset: 'node-mapping:reset',
  nodeMappingResetPreview: 'node-mapping:reset-preview',
  nodeRegistry: 'nodes:registry',
  nodeMappingHide: 'node-mapping:hide'
} as const
