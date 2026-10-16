// Node status rules (pure): combines the roster, telemetry and node mapping into the one picture
// the UI shows — availability, new-node detection, PDU-offline grouping and PDU readings.
import { BRIDGE_NODE_ID, type NodeSeen, type NodeStatus } from './nodes'
import { isAdoptableKind, resolveKind, type NodeIdentity } from './node-kind'
import { hasFreshPduPage, type NodeTelemSnapshot } from './node-telem'
import {
  differingCount,
  effectiveMapping,
  type NodeDefaults,
  type NodeKind,
  type NodeMappingFile
} from './node-mapping'

/**
 * Nodes that lose power together stop heartbeating together, so the bridge's 3 s timeout fires
 * for all of them within one 500 ms heartbeat period and each arrives as a live delta. 2 s
 * covers that with margin.
 */
export const PDU_GROUP_WINDOW_MS = 2000
/**
 * A drop whose delta was lost is found by the next roster poll instead (every 5 s), so it can
 * arrive up to a poll plus the window after the PDU's.
 */
export const PDU_GROUP_POLL_CATCH_MS = 7000

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

export interface NodeModelInput {
  roster: NodeStatus[]
  seen: ReadonlyMap<number, NodeSeen>
  rosterCompleteAt?: number
  telemetry: NodeTelemSnapshot[]
  defaults: Map<number, NodeDefaults>
  file: NodeMappingFile
}

/**
 * Your cockpit (#93): the boards you added (registry) or adopted, remembered in node-mapping.json,
 * plus whatever is on the bus now that isn't in it yet — shown as new, a registry one pre-filled.
 * A registry board never added is a dictionary entry: not drawn, not counted, never offline. A registry board that never reported is a dictionary entry only:
 * not drawn, not counted, never offline.
 */
export function buildNodeModel(i: NodeModelInput): NodeModel {
  const mapping = effectiveMapping(i.defaults, i.file)
  const roster = new Map(i.roster.map((n) => [n.nodeId, n]))
  const telem = new Map(i.telemetry.map((t) => [t.nodeId, t]))
  const complete = i.rosterCompleteAt !== undefined
  const known = [...mapping.values()].filter((m) => m.known).map((m) => m.nodeId)
  // Not in your cockpit, registry or not: shown as new only while it is on the bus. The roster
  // keeps absent rows; one that dropped (or that you just forgot) comes back when it reports.
  const waiting = [...roster.values()].filter((n) => n.present).map((n) => n.nodeId)
  // PDU pages are a report too: a registry or adopted PDU sending them now is on the bus. Pages are
  // kept (only marked stale), so one that stopped sending — dropped, or forgotten — is not.
  const sending = [...telem.values()]
    .filter((t) => mapping.get(t.nodeId)?.known || (mapping.has(t.nodeId) && hasFreshPduPage(t)))
    .map((t) => t.nodeId)
  // The bridge's own row (node 0, v3) is this client's link, not a cockpit node.
  const ids = [...new Set([...known, ...waiting, ...sending])]
    .filter((id) => id !== BRIDGE_NODE_ID)
    .sort((a, b) => a - b)

  const nodes: NodeModelEntry[] = []
  const hidden: number[] = []
  const hiddenNodes: HiddenNode[] = []
  for (const nodeId of ids) {
    const mapped = mapping.get(nodeId)
    const m = mapped?.known ? mapped : undefined
    if (m?.hidden) {
      hidden.push(nodeId)
      hiddenNodes.push({ nodeId, name: m.name, console: m.console })
      continue
    }
    const st = roster.get(nodeId)
    const seen = i.seen.get(nodeId)
    const t = telem.get(nodeId)
    const source = m ? m.source : 'new'
    const identified = resolveKind({
      reported: st?.nodeKind,
      pduTelemetry: t?.isPdu,
      // Only a board in your cockpit has a stored kind. A new one — registry boards included — is
      // identified by what it reports (or PDU pages), never by its NODE_ID (#93 re-review C).
      stored: m?.kind
    })
    const kind: NodeKind = identified === 'pdu' ? 'pdu' : 'panel'
    // A board missing from the first complete roster is offline — there is no "waiting".
    const availability: NodeAvailability = st
      ? st.present
        ? 'online'
        : 'offline'
      : complete
        ? 'offline'
        : 'unknown'
    const e: NodeModelEntry = {
      nodeId,
      name: mapped?.name ?? `Node ${nodeId}`,
      console: m ? m.console : null,
      pduId: m && kind !== 'pdu' ? m.pduId : null,
      kind,
      source,
      availability,
      differs: m?.differs ?? false
    }
    if (availability === 'offline') {
      if (st) {
        e.offlineAt = seen?.offlineAt ?? i.rosterCompleteAt
        e.offlineVia = seen?.offlineVia ?? 'roster'
      } else e.notSeen = true // remembered, not listed since the link opened
    }
    const lastSeenAt = m?.lastSeen ? Date.parse(m.lastSeen) : NaN
    if (!Number.isNaN(lastSeenAt)) e.lastSeenAt = lastSeenAt
    if (identified) e.identified = identified
    if (st) e.status = st
    if (seen?.reportedAt !== undefined) e.reportedAt = seen.reportedAt
    if (source === 'new' && seen) e.firstSeenAt = seen.firstSeenAt
    if (source === 'new' && mapped) {
      e.registry = { name: mapped.name, console: mapped.console, pduId: mapped.pduId }
      const pdu = mapped.pduId === null ? undefined : mapping.get(mapped.pduId)
      if (pdu) e.registry.pduName = pdu.name
    }
    if (kind === 'pdu') {
      e.everHadReadings = t?.isPdu ?? false
      if (availability === 'online') e.readings = t && hasFreshPduPage(t) ? 'live' : 'none'
    }
    nodes.push(e)
  }

  return {
    nodes,
    outages: pduOutages(nodes),
    differingCount: differingCount(i.defaults, i.file),
    hidden,
    hiddenNodes,
    rosterComplete: complete
  }
}

/** Did `n` drop together with `pdu`? Both must be offline with a known time. */
export function droppedTogether(n: NodeModelEntry, pdu: NodeModelEntry): boolean {
  if (n.offlineAt === undefined || pdu.offlineAt === undefined) return false
  const d = n.offlineAt - pdu.offlineAt
  if (Math.abs(d) <= PDU_GROUP_WINDOW_MS) return true
  // One side was found late by a roster poll: it was still listed online when the other dropped.
  if (n.offlineVia === 'roster' && d > 0 && d <= PDU_GROUP_POLL_CATCH_MS) return true
  if (pdu.offlineVia === 'roster' && d < 0 && -d <= PDU_GROUP_POLL_CATCH_MS) return true
  return false
}

/** An offline PDU plus more than half of the nodes it feeds dropping with it → one outage. */
export function pduOutages(nodes: NodeModelEntry[]): PduOutage[] {
  const out: PduOutage[] = []
  for (const pdu of nodes) {
    if (pdu.kind !== 'pdu' || pdu.availability !== 'offline' || pdu.offlineAt === undefined) {
      continue
    }
    // A board not seen this session could not have dropped with it: it counts for neither side.
    const fed = nodes.filter((n) => n.pduId === pdu.nodeId && n.nodeId !== pdu.nodeId && !n.notSeen)
    const hit = fed.filter((n) => n.availability === 'offline' && droppedTogether(n, pdu))
    if (fed.length > 0 && hit.length * 2 > fed.length) {
      out.push({
        pduId: pdu.nodeId,
        nodeIds: hit.map((n) => n.nodeId),
        fedCount: fed.length,
        at: pdu.offlineAt
      })
    }
  }
  return out
}

/**
 * NODE_IDs present now that were not present at the previous roster change: the nodes that just
 * came (back) online. A node that stays present across updates is not in the list, which is what
 * lets a still-listed board be hidden without the next poll un-hiding it.
 */
export function cameOnline(previous: ReadonlySet<number>, roster: NodeStatus[]): number[] {
  return roster.filter((n) => n.present && !previous.has(n.nodeId)).map((n) => n.nodeId)
}

/**
 * A new device worth telling the user about: not in the registry or adopted, on the bus now, and
 * identified as something that can be adopted. Until then it is not news — not on the Cockpit
 * count, the Overview notice or the event log. One predicate for every tab (node 0 is never in the
 * model).
 */
export function isReportableNew(e: NodeModelEntry): boolean {
  return e.source === 'new' && e.availability === 'online' && isAdoptableKind(e.identified)
}
