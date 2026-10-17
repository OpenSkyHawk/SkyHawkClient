// Mapping changes one board at a time (R3.2b): the Adopt dialog's "Add all" and Settings' "Un-hide
// all". NodeHub runs them in the order given, each change awaited before the next. Each change
// pushes the model as it goes (NodeHub.update), just as each invoke did.
//
// - Add all stops at the first refusal: the boards after it are not tried.
// - Un-hide all (N4, #133) goes on past a board it can't un-hide and reports every one that failed.
// - Neither re-enters (R6, #133): a second call while one is still running is ignored — it answers
//   that it did nothing — so a double click never runs it twice.
import type { AdoptRequest, AdoptSpec, NodeBatchResult, NodeMappingResult } from '@shared/nodes'

/** One change, as NodeHub (or an invoke) answers it. undefined = no answer (counts as done). */
type Answer = NodeMappingResult | undefined | Promise<NodeMappingResult | undefined>

/** What a call made while the same sequence is still running answers: nothing was done. */
const IGNORED: NodeBatchResult = { ok: true, done: [] }

/** "Add all": adopt each board in turn; the first refusal stops it. */
export async function addAllInTurn(
  bulk: AdoptRequest[],
  adopt: (nodeId: number, spec: AdoptSpec) => Answer
): Promise<NodeBatchResult> {
  const added: number[] = []
  for (const b of bulk) {
    const r = await adopt(b.nodeId, b.spec)
    if (r && !r.ok) {
      const failed = [{ nodeId: b.nodeId, error: r.error }]
      return { ok: false, done: added, nodeId: b.nodeId, error: r.error, failed }
    }
    added.push(b.nodeId)
  }
  return { ok: true, done: added }
}

/**
 * "Un-hide" / "Un-hide all": show each board again in turn. A refusal doesn't stop it: every board
 * is tried, and the answer lists the ones that failed (the first also as `nodeId` / `error`).
 */
export async function unhideInTurn(
  ids: number[],
  hide: (nodeId: number, on: boolean) => Answer
): Promise<NodeBatchResult> {
  const done: number[] = []
  const failed: { nodeId: number; error: string }[] = []
  for (const id of ids) {
    const r = await hide(id, false)
    if (r && !r.ok) failed.push({ nodeId: id, error: r.error })
    else done.push(id)
  }
  const first = failed[0]
  return first
    ? { ok: false, done, nodeId: first.nodeId, error: first.error, failed }
    : { ok: true, done }
}

/**
 * The two sequences as NodeHub (and the component tests' mock) runs them: each one at a time. A
 * call made while the same sequence is running is ignored (`{ ok: true, done: [] }`), not run.
 */
export class MappingSequences {
  private adding = false
  private unhiding = false

  async addAll(
    bulk: AdoptRequest[],
    adopt: (nodeId: number, spec: AdoptSpec) => Answer
  ): Promise<NodeBatchResult> {
    if (this.adding) return IGNORED
    this.adding = true
    try {
      return await addAllInTurn(bulk, adopt)
    } finally {
      this.adding = false
    }
  }

  async unhide(
    ids: number[],
    hide: (nodeId: number, on: boolean) => Answer
  ): Promise<NodeBatchResult> {
    if (this.unhiding) return IGNORED
    this.unhiding = true
    try {
      return await unhideInTurn(ids, hide)
    } finally {
      this.unhiding = false
    }
  }
}
