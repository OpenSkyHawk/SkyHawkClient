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
import { boardIdentity, isAdoptableKind } from './node-kind'
import { BRIDGE_NODE_ID } from './node-status-wire'
import { hasFreshPduPage, pduPagesLive } from './node-telem'
import { pduOutages } from './power-zone'

export interface NodeModelInput {
  roster: NodeStatus[]
  seen: ReadonlyMap<number, NodeSeen>
  rosterCompleteAt?: number
  telemetry: NodeTelemSnapshot[]
  defaults: Map<number, NodeDefaults>
  file: NodeMappingFile
  /** When `telemetry` was taken: page ages are counted back from it. */
  now: number
}

/** What a board's availability was decided from: its roster row, its PDU pages, or nothing. */
export type AvailabilityEvidence = 'roster' | 'telemetry' | 'none'

export interface Availability {
  availability: NodeAvailability
  evidence: AvailabilityEvidence
}

/**
 * The one availability rule (X2 / S10), with what it was decided from:
 * - online while the roster lists it present (roster);
 * - online while its PDU pages say so (telemetry): fresh, and newer than the roster's last
 *   "absent" reading for it (node-telem.ts pduPagesLive — the newest evidence wins);
 * - offline once the roster lists it absent, or a complete roster left it out (roster) — there is
 *   no "waiting";
 * - else unknown (none): no complete roster since the link opened, and it has not reported.
 * `pduTelemetry` is that page evidence already weighed (availabilityOf).
 */
export function nodeAvailability(
  st: NodeStatus | undefined,
  rosterComplete: boolean,
  pduTelemetry: boolean
): Availability {
  if (st?.present) return { availability: 'online', evidence: 'roster' }
  if (pduTelemetry) return { availability: 'online', evidence: 'telemetry' }
  if (st || rosterComplete) return { availability: 'offline', evidence: 'roster' }
  return { availability: 'unknown', evidence: 'none' }
}

/** What the rule reads for one board: its roster row and timing, and its PDU pages. */
export interface AvailabilitySignals {
  status?: NodeStatus
  seen?: NodeSeen
  rosterComplete: boolean
  telemetry?: NodeTelemSnapshot
  /** When `telemetry` was taken. */
  now: number
}

/**
 * A board's availability from its signals: the model's, and the one NodeHub refuses Hide and Forget
 * by, so the two always agree. Pages count against the roster's last "absent" reading — the time
 * it learned the board was offline (seen.offlineAt) — only while the roster lists it absent.
 */
export function availabilityOf(s: AvailabilitySignals): Availability {
  const absentAt = s.status && !s.status.present ? s.seen?.offlineAt : undefined
  const pages = !!s.telemetry && pduPagesLive(s.telemetry, s.now, absentAt)
  return nodeAvailability(s.status, s.rosterComplete, pages)
}

/**
 * On the bus now: the link is up and the one availability rule says online. Every "on the bus"
 * surface reads this — the Cockpit's "New on the bus" and its strays, the Overview's new-devices
 * notice, Connection › Connected nodes and Settings › About's On the bus — so while the Gateway is
 * unplugged they all go quiet, whatever the last model said (X2 / R5).
 */
export function onBusNow(e: Pick<NodeModelEntry, 'availability'>, live: boolean): boolean {
  return live && e.availability === 'online'
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
  const signals = (nodeId: number): AvailabilitySignals => ({
    status: roster.get(nodeId),
    seen: i.seen.get(nodeId),
    rosterComplete: complete,
    telemetry: telem.get(nodeId),
    now: i.now
  })
  const known = [...mapping.values()].filter((m) => m.known).map((m) => m.nodeId)
  // Not in your cockpit, registry or not: shown as new only while it is on the bus. The roster
  // keeps absent rows; one that dropped (or that you just forgot) comes back when it reports.
  const waiting = [...roster.values()].filter((n) => n.present).map((n) => n.nodeId)
  // PDU pages are a report too: a registry or adopted PDU sending them now is on the bus — online
  // by them (nodeAvailability), so it can be adopted (S10). Pages are kept (only marked stale), so
  // one that stopped sending — dropped, or forgotten — is not.
  const sending = [...telem.values()]
    .filter(
      (t) => mapping.has(t.nodeId) && availabilityOf(signals(t.nodeId)).availability === 'online'
    )
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
      // Still in your cockpit (X1): what every surface needs to count it as a member.
      hidden.push(nodeId)
      const h: HiddenNode = {
        nodeId,
        name: m.name,
        console: m.console,
        kind: m.kind,
        source: m.source
      }
      if (m.kind !== 'pdu' && m.pduId !== null) h.pduId = m.pduId
      hiddenNodes.push(h)
      continue
    }
    const st = roster.get(nodeId)
    const seen = i.seen.get(nodeId)
    const t = telem.get(nodeId)
    const source = m ? m.source : 'new'
    // Only a board in your cockpit has a stored kind. A new one — registry boards included — is
    // identified by what it reports (or PDU pages), never by its NODE_ID (#93 re-review C).
    const identified = boardIdentity(mapping, nodeId, {
      reported: st?.nodeKind,
      pduTelemetry: t?.isPdu
    })
    const kind: NodeKind = identified === 'pdu' ? 'pdu' : 'panel'
    const { availability } = availabilityOf(signals(nodeId))
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
      // Its default PDU only while that PDU is in your cockpit (effectiveMapping, D7).
      e.registry = { name: mapped.name, console: mapped.console, pduId: mapped.pduId }
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
 * A new device worth telling the user about: not in your cockpit, on the bus now (onBusNow), and
 * identified as something that can be adopted. Until then it is not news — not on the Cockpit
 * count or the Overview notice. One predicate for every tab (node 0 is never in the model).
 */
export function isReportableNew(e: NodeModelEntry, live: boolean): boolean {
  return e.source === 'new' && onBusNow(e, live) && isAdoptableKind(e.identified)
}
