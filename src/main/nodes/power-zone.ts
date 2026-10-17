// Power zones (pure, no Node/Electron deps): what a board's zone resolves to, which boards a PDU
// feeds, and which of them dropped together with it, so a PDU outage reads as one event rather than
// one per board.
//
// A zone only ever names a PDU in your cockpit (D7: mapping-rules.ts zoneTarget makes the model's
// pduId that, or null). Here it is resolved once per snapshot to the status every surface reads —
// `active`, `hidden` or `none` — and named the one way every surface names it.
import type { NodeKind, NodeModelEntry, PduOutage, PowerZone } from '@shared/nodes'

/** What resolving a zone needs of a board in your cockpit (cockpit-snapshot/members.ts Member). */
export interface ZoneMember {
  nodeId: number
  name: string
  kind: NodeKind
  hidden: boolean
}

/**
 * How every surface names a PDU as a power zone: `PDU_Right`, `PDU_Right (hidden)`, and in a
 * picker `PDU_Right (other console)` or `PDU_Right (hidden, other console)`.
 */
export function zoneLabel(name: string, hidden: boolean, otherConsole = false): string {
  const marks = [hidden && 'hidden', otherConsole && 'other console'].filter(Boolean)
  return marks.length ? `${name} (${marks.join(', ')})` : name
}

/**
 * A board's power zone as every surface reads it (D7): `active` when it names a PDU in your cockpit
 * on the plan, `hidden` when that PDU is hidden until it reports again (the link is kept, B10),
 * else `none` — no zone, or one that names anything but a PDU in your cockpit.
 */
export function resolveZone(
  member: (nodeId: number) => ZoneMember | undefined,
  pduId: number | null | undefined
): PowerZone {
  const pdu = pduId === null || pduId === undefined ? undefined : member(pduId)
  if (!pdu || pdu.kind !== 'pdu') return { status: 'none' }
  return {
    status: pdu.hidden ? 'hidden' : 'active',
    pduId: pdu.nodeId,
    name: pdu.name,
    label: zoneLabel(pdu.name, pdu.hidden)
  }
}

/** Every board's resolved zone, by NODE_ID — once per snapshot. A PDU has none. */
export function boardZones(
  entries: readonly NodeModelEntry[],
  member: (nodeId: number) => ZoneMember | undefined
): Map<number, PowerZone> {
  return new Map(
    entries.map((e) => [e.nodeId, resolveZone(member, e.kind === 'pdu' ? null : e.pduId)])
  )
}

/**
 * The boards `pduId` feeds — the one fed-boards rule (X7): every board whose zone names it. Given
 * your cockpit's boards (hidden ones included) it is what a PDU's Feeds lists and what Forget
 * unlinks; an outage counts those of them that could have dropped with it (pduOutages).
 */
export function fedBy<T extends { nodeId: number; pduId?: number | null }>(
  boards: readonly T[],
  pduId: number
): T[] {
  return boards.filter((b) => b.pduId === pduId && b.nodeId !== pduId)
}

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

/** Did `n` drop together with `pdu`? Both must be offline with a known time. */
function droppedTogether(n: NodeModelEntry, pdu: NodeModelEntry): boolean {
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
    // The model's boards are the ones not hidden. A board hidden, or not seen this session, could
    // not have dropped with it: it counts for neither side.
    const fed = fedBy(nodes, pdu.nodeId).filter((n) => !n.notSeen)
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
