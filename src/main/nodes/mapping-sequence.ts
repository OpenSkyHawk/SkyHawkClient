// Mapping changes one board at a time (R3.2b): the Adopt dialog's "Add all" and Settings' "Un-hide
// all". The renderer ran these loops itself, one invoke per board (AdoptDialog `addAll`,
// CockpitSection `unhide`); NodeHub runs them now, the same way: in the order given, each change
// awaited before the next, stopping at the first refusal. Each change pushes the model as it goes
// (NodeHub.update), just as each invoke did.
//
// Today's defects stay as they are (fix track): Add all adds what it can before a refusal and the
// rest are not tried; Un-hide all stops at the first board it can't un-hide.
import type { AdoptRequest, AdoptSpec, NodeBatchResult, NodeMappingResult } from '@shared/nodes'

/** One change, as NodeHub (or an invoke) answers it. undefined = no answer (counts as done). */
type Answer = NodeMappingResult | undefined | Promise<NodeMappingResult | undefined>

/** "Add all": adopt each board in turn; the first refusal stops it. */
export async function addAllInTurn(
  bulk: AdoptRequest[],
  adopt: (nodeId: number, spec: AdoptSpec) => Answer
): Promise<NodeBatchResult> {
  const added: number[] = []
  for (const b of bulk) {
    const r = await adopt(b.nodeId, b.spec)
    if (r && !r.ok) return { ok: false, done: added, nodeId: b.nodeId, error: r.error }
    added.push(b.nodeId)
  }
  return { ok: true, done: added }
}

/** "Un-hide" / "Un-hide all": show each board again in turn; the first refusal stops it. */
export async function unhideInTurn(
  ids: number[],
  hide: (nodeId: number, on: boolean) => Answer
): Promise<NodeBatchResult> {
  const done: number[] = []
  for (const id of ids) {
    const r = await hide(id, false)
    if (r && !r.ok) return { ok: false, done, nodeId: id, error: r.error }
    done.push(id)
  }
  return { ok: true, done }
}
