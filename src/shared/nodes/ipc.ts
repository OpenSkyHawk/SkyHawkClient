// Nodes topic contract (arch-phase0-v2 §2.3): the CAN node roster, PDU telemetry, the node mapping
// and the PSU limits the Cockpit draws against. Imported by main, preload and the renderer.
import type { TELEM_PAGES } from '../firmware'
import { DASH } from '../format'

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

/**
 * What node-mapping.json holds for one NODE_ID (v4, sparse): whether it is in your cockpit, the kind
 * the board reported, and only the fields you changed. Absent = the registry's value, so a later
 * NODE_IDS.md (a better default name or console) still reaches a board that left that field alone.
 */
export interface NodeOverride {
  /** Only what you changed: for a registry board, a value equal to NODE_IDS.md is stored as absent. */
  name?: string
  console?: string
  /** Power zone: the PDU NODE_ID feeding this node. null = explicitly none. */
  pduId?: number | null
  /**
   * The kind the board itself reported (its NODE_KIND, or PDU pages), stored when it is added and
   * whenever it reports. Absent = it has not reported since this was stored: a registry board then
   * reads as its registry kind.
   */
  kind?: NodeKind
  /** Replaced / removed board: skip it until it reports again. */
  hidden?: boolean
  /**
   * In your cockpit: the one marker, for a registry board you added and a board you adopted alike.
   * Reset keeps it; only Forget removes it.
   */
  added?: boolean
  /**
   * When it was last on the bus, ISO 8601: written for a board in your cockpit when it comes
   * online, when it drops and when the link closes.
   */
  lastSeen?: string
}

export interface NodeMappingFile {
  version: 4
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
  /** Registry node with a field that differs from NODE_IDS.md (what reset would undo). */
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

// Which values a PSU limit accepts (R3.4a). Part of the
// contract because both sides need the same answer: main sanitizes a saved or imported limit with
// it (psu-limits.ts), and the renderer marks a limit field invalid on every keystroke, from the text
// typed since the form mounted, before anything is saved.

/** Largest value accepted for any limit; anything above is a typo, not a desktop PSU. */
export const PSU_LIMIT_MAX = 10000

export const isLimit = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= PSU_LIMIT_MAX

/**
 * Parse one limit as typed. Empty means "unknown" (undefined); anything that is not a positive
 * number up to PSU_LIMIT_MAX is refused (null), so the field can show it and nothing is saved.
 */
export function parsePsuLimit(text: string): number | undefined | null {
  const t = text.trim()
  if (!t) return undefined
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  const n = Number(t)
  return isLimit(n) ? n : null
}

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

/** One board for "Add all" (R3.2): the NODE_ID and what to adopt it as. */
export interface AdoptRequest {
  nodeId: number
  spec: AdoptSpec
}

/**
 * Mapping changes run one board at a time ("Add all", "Un-hide all"; R3.2): the NODE_IDs done in
 * order, and — when one was refused — that one and why. The boards after it were not tried.
 */
export type NodeBatchResult =
  | { ok: true; done: number[] }
  | { ok: false; done: number[]; nodeId: number; error: string }

// ── consoles ────────────────────────────────────────────────────────────────

/** NODE_IDS.md console names, as the mapping stores them. */
export const CONSOLE_OPTIONS = [
  { value: 'Left', label: 'Left console' },
  { value: 'Center', label: 'Instrument panel' },
  { value: 'Right', label: 'Right console' }
] as const

export function consoleLabel(console: string | null): string {
  return CONSOLE_OPTIONS.find((c) => c.value === console)?.label ?? console ?? DASH
}

// ── the Cockpit snapshot (R3.2): built in main, pushed on `cockpit:snapshot` ──
//
// Everything the Cockpit tab decides, decided once in main (nodes/cockpit-snapshot) from the node
// model, the telemetry, the link and the time, and pushed with a revision. The tab keeps only
// presentation: the plan's geometry, wording, the search box and its own view state.

/** How a node reads on the plan. 'unknown' = no complete roster yet and it has not reported. */
export type NodeState = 'on' | 'warn' | 'off' | 'new' | 'unknown'

/** A PDU's pages that are fresh right now. A stale page is not a reading. */
export interface PduReadings {
  rail12V?: PduRailPage
  rail5V?: PduRailPage
  status?: PduStatusPage
}

export interface NodeHealth {
  state: NodeState
  /** Short reason shown on Attention and tile tooltips, e.g. `OFFLINE`, `I2C`, `5V UNDER-V`. */
  flag?: string
}

/** Everything the tab needs about one node, computed once per push. */
export interface NodeView {
  entry: NodeModelEntry
  health: NodeHealth
  /** PDUs: fresh pages only. */
  readings: PduReadings
  /** PDUs: online but no fresh telemetry. */
  noReadings: boolean
}

export interface AttentionItem {
  key: string
  nodeId: number
  name: string
  state: NodeState
  flag: string
  /** A PDU outage: one item for the PDU and every node that dropped with it. */
  outage?: PduOutage
  /** A new board on the bus that can't be adopted (#93): its cog opens the Adopt dialog. */
  stray?: boolean
}

/** A new board that can't be adopted, and what Attention says about it (strayNew). */
export interface StrayItem {
  nodeId: number
  flag: string
}

export interface HealthBand {
  online: number
  /**
   * Your cockpit's boards (registry + adopted, PDUs included), plus new boards on the bus that
   * can't be adopted — those are active and a warning (#93). New boards waiting for Adopt are not
   * counted.
   */
  total: number
  warn: number
  off: number
  /** No complete roster yet and not reported: no data, so neither online nor offline. */
  unknown: number
  /** Summed over PDUs with fresh readings. null = no PDU has any. */
  amps12: number | null
  amps5: number | null
  watts12: number | null
  watts: number | null
  /** PDUs on the plan that have no fresh readings (offline or none). */
  pdusWithout: number
  pdusWith: number
  /** Lowest 5 V rail average and the PDU it is on. */
  low5?: { volts: number; nodeId: number; name: string }
  /** Highest TEC / REC among online nodes. */
  worstCan?: { tec: number; rec: number; nodeId: number; name: string }
  busOff: number
  /** The first board that is bus-off (lowest NODE_ID): the CAN card names it before any count. */
  busOffBoard?: { nodeId: number; name: string }
  hottest?: { tempC: number; nodeId: number; name: string; level: 'ok' | 'warn' | 'crit' }
}

/** The health band: the counts and totals, and what the CAN errors card says. */
export interface CockpitBand {
  band: HealthBand
  /** The CAN card's value: the worse of TEC and REC (REC only when it is higher). */
  canValue?: { counter: 'TEC' | 'REC'; value: number }
  /** The CAN card's sub-line. */
  canSub: string
  /** Who the CAN card's "worst" is, for its tooltip; undefined when it names no board. */
  canWorst?: string
  /** Highest total W the client computed this session. */
  peakW: number
}

/** Cockpit › Attention. Items only while the link is up. */
export interface CockpitAttention {
  /** The Gateway's own problem (#94): first, taking one of the shown slots. */
  gateway?: { flag: string; state: 'off' | 'warn' }
  /** Every item, most severe first (without the Gateway's). */
  items: AttentionItem[]
  /** The items that fit before "+N more". */
  shown: AttentionItem[]
  /** Items in all, the Gateway's included. */
  count: number
  /** How many did not fit. */
  more: number
  /** "New on the bus · N": new boards that identified as something adoptable. */
  newCount: number
}

/** Plan console: `Left` / `Center` / `Right` in NODE_IDS.md; anything else lands on the panel. */
export type ConsoleKey = 'L' | 'C' | 'R'

/** A PDU group's header on the plan. */
export interface PlanGroupHead {
  /** The PDU is offline: OFFLINE is its only flag. */
  off: boolean
  /** Its flags, most important first (the header shows the first, the tooltip all). */
  flags: string[]
  /** Online without fresh telemetry. */
  noReadings: boolean
  /** A rail's average, while it has one to show; `alert` when the PDU flags that rail. */
  rail12V?: { mv: number; alert: boolean }
  rail5V?: { mv: number; alert: boolean }
}

/** One power zone on a console: a PDU and the panels it feeds, or the panels with no zone. */
export interface PlanZone {
  key: string
  /** The PDU heading this group; null = nodes with no power zone on this console. */
  pdu: NodeView | null
  head?: PlanGroupHead
  members: NodeView[]
  outage?: PduOutage
}

export interface PlanConsole {
  key: ConsoleKey
  zones: PlanZone[]
  /** The console's PDUs in plan order: one feed line each, `true` while it raises a rail flag. */
  feeds: boolean[]
}

/** A footer button: shown, and when it can't be used, why (its tooltip). */
export interface BoardAction {
  disabled: boolean
  tip: string
}

/** The footer every board panel shares (#93), besides Save. */
export interface BoardActions {
  /** Registry boards only: back to the NODE_IDS.md name, console and power zone. */
  reset?: BoardAction
  forget: BoardAction
  hide: BoardAction
  /** The line under the footer: what Forget and Hide do here, or why they can't. */
  note: string
}

export interface FaultBox {
  tone: 'warn' | 'err' | 'new'
  title: string
  text: string
}

export interface Row {
  k: string
  v: string
}

export interface RailRow {
  rail: '12 V' | '5 V'
  avg: string
  min: string
  amps: string
  peak: string
  /** Client-computed V × A; '' when there is nothing to compute. */
  watts: string
  flagged: boolean
}

/** One board's side panel: what it says and offers. */
export interface BoardPanel {
  /** In your cockpit (not new): Powered by, Placement and the footer show. */
  placed: boolean
  /** The boxes at the top of the Status tab, stacked. */
  faults: FaultBox[]
  actions: BoardActions
  /** Panel groups: "Reported by the node". */
  status?: Row[]
  /** Panel groups: the PDU feeding it (its power zone, wherever that PDU is). */
  poweredBy?: number
  /** PDUs: "Rails · live". */
  rails?: RailRow[]
  /** PDUs: "Board status". */
  board?: Row[]
  /** PDUs: the boards in your cockpit it feeds, each with its state. */
  feeds?: { nodeId: number; detail: string }[]
  /** PDUs: the other PDUs in your cockpit on its console. */
  sharedWith?: string[]
}

/**
 * The power zones a panel can be given. `options[console][current]` is the Power zone list for a
 * panel on `console` whose zone is `current` ('' = none, or a PDU not in your cockpit); `first` is
 * the zone picking that console picks.
 */
export interface ZoneChoices {
  options: Record<string, Record<string, { value: number; label: string }[]>>
  first: Record<string, number | null>
}

/** What the Adopt dialog can say about a new NODE_ID: only what it has reported. */
export interface Evidence {
  /** What it identified as, and from which signal; or that it hasn't yet. */
  detected: string
  reporting: string
  registry: string
}

export interface AdoptForm {
  name: string
  console: string
  /** Panels only. '' = not chosen yet; null = None (no PDU feeds it). */
  pduId: number | null | ''
}

export type AdoptBadge = 'PDU' | 'PANEL GROUP' | 'IDENTIFYING' | 'BRIDGE' | 'UNKNOWN TYPE'

/** One row of the Adopt dialog's queue. */
export interface AdoptRow {
  view: NodeView
  /** Set only when it can be adopted: what it identified as. */
  kind?: NodeKind
  badge: AdoptBadge
  /** Why it can't be adopted (yet), shown in place of the form. */
  note?: string
  evidence: Evidence
  /** The same, once it has dropped off the bus (the dialog keeps it listed, offline). */
  goneEvidence: Evidence
  /** Where the form starts: the NODE_IDS.md pre-fill, or blank. */
  prefill: AdoptForm
  /** Its default PDU when that PDU is not in your cockpit: offered as "(not added)", by this name. */
  pending?: { pduId: number; name: string }
  /**
   * "Add all" (registry panel groups only): the power zone an untouched form is added with — its
   * default PDU only when that PDU is in your cockpit, else None.
   */
  addAllPduId?: number | null
}

// ── Overview, Connection and Settings (R3.2b): each surface's own reading of the same picture ──

/** The Overview's Cockpit tile. */
export interface CockpitTile {
  value: string
  sub: string
  /** Worst state among known nodes, drawn as its symbol before the value. Healthy = none. */
  symbol?: 'off' | 'warn'
  /** ok = all up and healthy; issue = something offline or warning; none = no live status. */
  tone: 'ok' | 'issue' | 'none'
}

/** The Overview's Attention banner. */
export interface AttentionSummary {
  /** `8 nodes need attention` */
  head: string
  /** `3 offline (Left_Oxygen, Right_TACAN, Center_Clock) · 5 warnings` */
  detail: string
}

/** The Overview's new-devices notice: what waits to be adopted, by kind. */
export interface NewDevices {
  count: number
  panels: number
  pdus: number
  /** Of them, boards in NODE_IDS.md waiting to be added (#93: pre-filled in New on the bus). */
  registry: number
}

/** What the Overview shows about your cockpit. */
export interface OverviewSummary {
  tile: CockpitTile
  /** While the link is up and a board reports a problem; the Settings toggle is the renderer's. */
  banner: AttentionSummary | null
  /** null = nothing to show, including while the link is down. */
  newDevices: NewDevices | null
}

export interface SummaryRow {
  nodeId: number
  name: string
  state: NodeState
  /** Chip text: `OFFLINE`, `BUS-OFF`, or the flags the board raised. */
  chip: string
  tone: 'err' | 'warn'
  /**
   * `#13 · PDU_Left · offline since 21:11:18`, or for a board remembered from an earlier session
   * that hasn't reported since the link opened, `… · not seen this session · last seen 14 Oct,
   * 21:13` — "offline since" would be the roster's time, not when it went (#93).
   */
  meta: string
}

/** Connection › Connected nodes. */
export interface NodesSummary {
  /** Known nodes (registry + adopted, PDUs included); new nodes are not counted. */
  known: number
  healthy: number
  warn: number
  off: number
  /** No complete roster yet and not reported. */
  unknown: number
  /** Known nodes that are PDUs, by their kind (never by NODE_ID). */
  pdus: number
  /** Client-computed total over PDUs with fresh readings; null = none has any. */
  watts: number | null
  /** The most severe nodes, in Cockpit Attention order. */
  rows: SummaryRow[]
  /** Attention items not shown. */
  more: number
  /** `+5 more · healthy nodes hidden`; empty when there is nothing to say. */
  footer: string
}

/** A registry row's "On the bus" column. */
export type OnBus = { text: string; dot: 'on' | 'off' | '' }

/** One row of Settings › About › Node registry. */
export interface RegistryRow {
  nodeId: number
  /** As the client shows it: the bridge row is the Gateway (#94). */
  name: string
  console: string
  /** From the link and the last model. */
  onBus: OnBus
  /** The same before the dialog's own pull of the node data has landed (no model yet). */
  unloaded: OnBus
}

/** What Settings shows about the node mapping. */
export interface SettingsNodes {
  /** Registry nodes that differ from NODE_IDS.md. */
  differing: number
  /** Reset… is offered: something differs, or an adopted board is on the plan. */
  canReset: boolean
  /** Settings › Hidden boards. */
  hidden: HiddenNode[]
  /** Settings › About › Node registry: the summary line and the dialog's rows. */
  registry: { summary: string; rows: RegistryRow[] }
}

export interface CockpitSnapshot {
  /** Increases with every snapshot main builds. */
  rev: number
  /** The Gateway link was up when this was built. */
  live: boolean
  views: NodeView[]
  outages: PduOutage[]
  plan: PlanConsole[]
  band: CockpitBand
  attention: CockpitAttention
  /** Each board's side panel, by NODE_ID. */
  panels: Record<number, BoardPanel>
  zones: ZoneChoices
  /** The Adopt dialog's queue: new NODE_IDs, oldest first seen first. */
  adopt: AdoptRow[]
  /** The Overview's tile, banner and new-devices notice (R3.2b). */
  overview: OverviewSummary
  /** Connection › Connected nodes (R3.2b). */
  nodesCard: NodesSummary
  /** Settings › Cockpit and About (R3.2b). */
  settings: SettingsNodes
}

/** What the Cockpit shows before main's first snapshot: no model, link down. */
export const COCKPIT_IDLE: CockpitSnapshot = {
  rev: 0,
  live: false,
  views: [],
  outages: [],
  plan: [
    { key: 'L', zones: [], feeds: [] },
    { key: 'C', zones: [], feeds: [] },
    { key: 'R', zones: [], feeds: [] }
  ],
  band: {
    band: {
      online: 0,
      total: 0,
      warn: 0,
      off: 0,
      unknown: 0,
      amps12: null,
      amps5: null,
      watts12: null,
      watts: null,
      pdusWithout: 0,
      pdusWith: 0,
      busOff: 0
    },
    canSub: '0 bus-off',
    peakW: 0
  },
  attention: { items: [], shown: [], count: 0, more: 0, newCount: 0 },
  panels: {},
  zones: {
    options: { '': { '': [] }, Left: { '': [] }, Center: { '': [] }, Right: { '': [] } },
    first: { '': null, Left: null, Center: null, Right: null }
  },
  adopt: [],
  overview: {
    tile: { value: '—', sub: 'no live node status', tone: 'none' },
    banner: null,
    newDevices: null
  },
  nodesCard: {
    known: 0,
    healthy: 0,
    warn: 0,
    off: 0,
    unknown: 0,
    pdus: 0,
    watts: null,
    rows: [],
    more: 0,
    footer: ''
  },
  settings: { differing: 0, canReset: false, hidden: [], registry: { summary: '', rows: [] } }
}

/** This topic's main -> renderer pushes; shared/app assembles them into `PushChannels`. */
export interface NodesPushChannels {
  /** Roster + telemetry + node mapping combined: what the Cockpit tab shows (#61, UI in #63). */
  'nodes:model': NodeModel
  /** Everything the Cockpit tab decides, built in main (R3.2). */
  'cockpit:snapshot': CockpitSnapshot
}

/** Push channel names (main -> renderer). */
export const NODES_PUSH = {
  nodesModel: 'nodes:model',
  cockpitSnapshot: 'cockpit:snapshot'
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
  nodeMappingHide: 'node-mapping:hide',
  nodeMappingAddAll: 'node-mapping:add-all',
  nodeMappingUnhide: 'node-mapping:unhide'
} as const
