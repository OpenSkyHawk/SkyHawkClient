// Power zones (pure, no Node/Electron deps): which boards dropped together with the PDU that feeds
// them, so a PDU outage reads as one event rather than one per board.
import type { NodeModelEntry, PduOutage } from '@shared/nodes'

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
