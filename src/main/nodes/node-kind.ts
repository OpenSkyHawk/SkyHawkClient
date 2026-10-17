// What a node is (pure, no Node/Electron deps). One resolver for the whole client — the model, main's
// mapping validation, Ignore's recorded kind, the Adopt gate and the Overview — so no two places
// can disagree about a board. Never inferred from a NODE_ID: a PDU can take any ID (#344).
import type { NodeIdentity, NodeKind } from '@shared/nodes'
import { reportedIdentity } from '@shared/nodes/legacy-rules'

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
