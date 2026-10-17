// What a node is (pure, no Node/Electron deps). One resolver for the whole client — the model, main's
// mapping validation, Ignore's recorded kind, the Adopt gate and the Overview — so no two places
// can disagree about a board. Never inferred from a NODE_ID: a PDU can take any ID (#344).
import { NODE_KIND } from './nodes'
import type { NodeIdentity, NodeKind } from './nodes/ipc'

/** The kind a status row reports (NodeStatus.nodeKind); undefined = not reported (0) or no row. */
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

export interface KindSignals {
  /** The board's own announcement (NodeStatus.nodeKind, v3). */
  reported?: number
  /** It has sent a PDU `_NODE_TELEM` page this session — only a PDU does. */
  pduTelemetry?: boolean
  /** What the registry or an adoption stored. */
  stored?: NodeKind
}

/**
 * The strongest signal wins: what the board announces, then PDU telemetry, then what was stored.
 * undefined = nothing solid yet (a new node before it reports its kind).
 */
export function resolveKind(s: KindSignals): NodeIdentity | undefined {
  return reportedIdentity(s.reported) ?? (s.pduTelemetry ? 'pdu' : undefined) ?? s.stored
}

/** Only these can be adopted — a whitelist, so unknown, bridge and any future kind never are. */
export function isAdoptableKind(k: NodeIdentity | undefined): k is NodeKind {
  return k === 'pdu' || k === 'panel'
}
