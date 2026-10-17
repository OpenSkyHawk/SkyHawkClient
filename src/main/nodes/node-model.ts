// Node status rules (pure): combines the roster, telemetry and node mapping into the one picture
// the UI shows — availability, new-node detection, PDU-offline grouping and PDU readings.
import type {
  HiddenNode,
  NodeAvailability,
  NodeDefaults,
  NodeKind,
  NodeMappingFile,
  NodeModel,
  NodeModelEntry,
  NodeSeen,
  NodeStatus,
  NodeTelemSnapshot
} from '@shared/nodes'
import { differingCount, effectiveMapping } from './mapping-rules'
import { isAdoptableKind, resolveKind } from './node-kind'
import { BRIDGE_NODE_ID } from './node-status-wire'
import { hasFreshPduPage } from './node-telem'
import { pduOutages } from './power-zone'

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

/**
 * A new device worth telling the user about: not in the registry or adopted, on the bus now, and
 * identified as something that can be adopted. Until then it is not news — not on the Cockpit
 * count, the Overview notice or the event log. One predicate for every tab (node 0 is never in the
 * model).
 */
export function isReportableNew(e: NodeModelEntry): boolean {
  return e.source === 'new' && e.availability === 'online' && isAdoptableKind(e.identified)
}
