// Renderer still calls these; they move to main in R3.x and this file disappears.
//
// Pure, no Node/Electron deps. Main imports them from here too, so there is one copy.
import { NODE_KINDS as NODE_KIND, PDU_RAIL_FLAGS, PDU_STATUS_FLAGS } from '../firmware'
import type { NodeIdentity, NodeKind, NodeModelEntry, NodeStatus } from './ipc'

/**
 * PDU_RAIL_* byte 1 bits (PDU_RAIL_FLAGS). All zero = healthy.
 *
 * @deprecated Renderer still calls this; it moves to main in R3.x.
 */
export const RAIL_FLAG = PDU_RAIL_FLAGS

/**
 * PDU_STATUS byte 1 bits (PDU_STATUS_FLAGS). All zero = healthy, calibrated.
 *
 * @deprecated Renderer still calls this; it moves to main in R3.x.
 */
export const PDU_FLAG = PDU_STATUS_FLAGS

/**
 * iAvgMa for display: residual negative offset reads as 0.
 *
 * @deprecated Renderer still calls this; it moves to main in R3.x.
 */
export function displayCurrentMa(ma: number): number {
  return Math.max(0, ma)
}

/**
 * Short degraded-badge tag — the fault abbr, or `Fault N` for an unknown/reserved id.
 *
 * @deprecated Renderer still calls this; it moves to main in R3.x.
 */
export function nodeFaultTag(n: NodeStatus): string {
  return n.faultAbbr ?? `Fault ${n.faultId}`
}

/**
 * The kind a status row reports (NodeStatus.nodeKind); undefined = not reported (0) or no row.
 *
 * @deprecated Renderer still calls this; it moves to main in R3.x.
 */
export function reportedIdentity(nodeKind: number | undefined): NodeIdentity | undefined {
  switch (nodeKind) {
    case undefined:
    case NODE_KIND.UNKNOWN:
      return undefined
    case NODE_KIND.PANEL_GROUP:
      return 'panel'
    case NODE_KIND.PDU:
      return 'pdu'
    case NODE_KIND.BRIDGE:
      return 'bridge'
    default:
      return 'other'
  }
}

/**
 * Only these can be adopted — a whitelist, so unknown, bridge and any future kind never are.
 *
 * @deprecated Renderer still calls this; it moves to main in R3.x.
 */
export function isAdoptableKind(k: NodeIdentity | undefined): k is NodeKind {
  return k === 'pdu' || k === 'panel'
}

/**
 * A new device worth telling the user about: not in the registry or adopted, on the bus now, and
 * identified as something that can be adopted. Until then it is not news — not on the Cockpit
 * count, the Overview notice or the event log. One predicate for every tab (node 0 is never in the
 * model).
 *
 * @deprecated Renderer still calls this; it moves to main in R3.x.
 */
export function isReportableNew(e: NodeModelEntry): boolean {
  return e.source === 'new' && e.availability === 'online' && isAdoptableKind(e.identified)
}

/**
 * Largest value accepted for any limit; anything above is a typo, not a desktop PSU.
 *
 * @deprecated Renderer still calls this; it moves to main in R3.x.
 */
export const PSU_LIMIT_MAX = 10000

/** @deprecated Renderer still calls this; it moves to main in R3.x. */
export const isLimit = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= PSU_LIMIT_MAX

/**
 * Parse one limit as typed. Empty means "unknown" (undefined); anything that is not a positive
 * number up to PSU_LIMIT_MAX is refused (null), so the field can show it and nothing is saved.
 *
 * @deprecated Renderer still calls this; it moves to main in R3.x.
 */
export function parsePsuLimit(text: string): number | undefined | null {
  const t = text.trim()
  if (!t) return undefined
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  const n = Number(t)
  return isLimit(n) ? n : null
}
