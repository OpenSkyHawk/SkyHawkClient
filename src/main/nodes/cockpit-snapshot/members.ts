// Your cockpit's boards as the snapshot reads them (X1, S2/R4): every board membership.ts inCockpit
// says is in — the ones on the plan (a view not 'new') and the hidden ones (the model's
// hiddenNodes) alike. Hidden only takes a board off the Cockpit until it reports again; it is still
// in your cockpit, so a hidden PDU is never "(not added)" and a hidden adopted board is still one
// Reset… can forget. Every surface that asks "is it in your cockpit?" reads this, never the views.
import type { NodeKind, NodeModel } from '@shared/nodes'

/** One board in your cockpit. */
export interface Member {
  nodeId: number
  name: string
  console: string
  kind: NodeKind
  source: 'registry' | 'adopted'
  /** Hidden until it reports again: not on the plan, still in your cockpit. */
  hidden: boolean
  /** The PDU feeding it (a PDU in your cockpit), else null. */
  pduId: number | null
}

export interface Members {
  /** Every board in your cockpit, by NODE_ID. */
  all: Member[]
  /** The PDUs among them: what a power zone can name. */
  pdus: Member[]
  get(nodeId: number): Member | undefined
}

/**
 * The boards in your cockpit, by NODE_ID: the model's entries that are not new, and its hidden
 * boards. None before the first model.
 */
export function cockpitMembers(model: NodeModel | undefined): Members {
  const all: Member[] = []
  for (const e of model?.nodes ?? []) {
    if (e.source === 'new') continue
    all.push({
      nodeId: e.nodeId,
      name: e.name,
      console: e.console ?? '',
      kind: e.kind,
      source: e.source,
      hidden: false,
      pduId: e.pduId
    })
  }
  for (const h of model?.hiddenNodes ?? []) all.push({ ...h, hidden: true, pduId: h.pduId ?? null })
  all.sort((a, b) => a.nodeId - b.nodeId)
  const byId = new Map(all.map((m) => [m.nodeId, m]))
  return { all, pdus: all.filter((m) => m.kind === 'pdu'), get: (id) => byId.get(id) }
}
