// What a node is (pure, no Node/Electron deps). One resolver for the whole client — the model, main's
// mapping validation, the kinds stored on boards in your cockpit, the Adopt gate and the Overview —
// so no two places can disagree about a board (S7). Never inferred from a NODE_ID: a PDU can take
// any ID (#344).
import { NODE_KINDS as NODE_KIND } from '@shared/firmware'
import type { MappedNode, NodeIdentity, NodeKind } from '@shared/nodes'
import { MappingError } from './mapping-error'

export interface KindSignals {
  /** The board's own announcement (NodeStatus.nodeKind, v3). */
  reported?: number
  /** It has sent a PDU `_NODE_TELEM` page this session — only a PDU does. */
  pduTelemetry?: boolean
  /** What the registry or an adoption stored. */
  stored?: NodeKind
}

/**
 * A board's identity — the one way to resolve it. The strongest signal wins: what the board
 * announces, then PDU telemetry, then what was stored. undefined = nothing solid yet (a new node
 * before it reports its kind).
 */
export function identityOf(s: KindSignals): NodeIdentity | undefined {
  return reportedIdentity(s.reported) ?? (s.pduTelemetry ? 'pdu' : undefined) ?? s.stored
}

/**
 * A board's identity from its live signals and the effective mapping: only a board in your cockpit
 * has a stored kind (the one it reported before, else its registry kind). A new one — a registry
 * board not added yet included — is what it reports, never what its NODE_ID suggests (#93
 * re-review C). What the model shows and what main's mutators check (their KindOf) both read this.
 */
export function boardIdentity(
  mapped: ReadonlyMap<number, MappedNode>,
  nodeId: number,
  live: Omit<KindSignals, 'stored'>
): NodeIdentity | undefined {
  const m = mapped.get(nodeId)
  return identityOf({ ...live, stored: m?.known ? m.kind : undefined })
}

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

/** Only these can be adopted — a whitelist, so unknown, bridge and any future kind never are. */
export function isAdoptableKind(k: NodeIdentity | undefined): k is NodeKind {
  return k === 'pdu' || k === 'panel'
}

/**
 * The adopt gate — every path that adds a board to your cockpit goes through it (S7): a board is
 * added only once it has said what it is, and only as a PDU or a panel group (#344). `as` is the
 * kind the request asks for, when it names one: it must be what the board said. Returns the kind
 * to store; refuses with a MappingError, worded for the user.
 */
export function requireAdoptable(k: NodeIdentity | undefined, as?: NodeKind): NodeKind {
  if (k === undefined) throw new MappingError('Its board type is not known yet')
  if (!isAdoptableKind(k)) throw new MappingError('This board cannot be adopted')
  if (as !== undefined && k !== as) {
    throw new MappingError(`It reports as a ${k === 'pdu' ? 'PDU' : 'panel group'}`)
  }
  return k
}
