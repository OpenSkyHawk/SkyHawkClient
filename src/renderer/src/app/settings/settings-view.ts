// Settings wording (#67), pure so it is unit-tested: what each Cockpit row says. The registry rows
// and Reset…'s gate are main's (cockpit:snapshot settings, R3.2b). The Import rows' wording is
// config/import-view.ts.
import { plural } from '@shared/format'
import type { CockpitSnapshot, HiddenNode, NodeBatchResult } from '@shared/nodes'
import { consoleLabel } from '@shared/nodes'

/** "Reset node mapping" row description. */
export function resetRowDesc(differing: number): string {
  return differing === 0
    ? 'Every node matches NODE_IDS.md'
    : `${plural(differing, 'node')} ${differing === 1 ? 'differs' : 'differ'} from NODE_IDS.md — return them to their registry name, console and PDU`
}

/**
 * The confirm button: "Reset 3 nodes", "Reset 3 nodes + forget 1", "Forget 1 adopted node", or a
 * plain "Reset" (shown disabled) when there is nothing to do.
 */
export function resetButtonLabel(nodes: number, forget: number): string {
  if (nodes === 0) return forget > 0 ? `Forget ${plural(forget, 'adopted node')}` : 'Reset'
  const reset = `Reset ${plural(nodes, 'node')}`
  return forget > 0 ? `${reset} + forget ${forget}` : reset
}

export interface ListRow {
  nodeId: number
  label: string
  desc: string
}

/** One Hidden boards row (#76): the name and console the Cockpit showed for it. */
export function hiddenRow(n: HiddenNode): ListRow {
  return {
    nodeId: n.nodeId,
    label: n.name,
    desc: n.console
      ? `${consoleLabel(n.console)} · returns when it reports again`
      : 'returns when it reports again'
  }
}

/**
 * What Hidden boards says when main refused an un-hide (N4): one board's refusal as main worded it;
 * from Un-hide all, every board it couldn't un-hide — by #id and the name it was listed under —
 * with its reason. The others were un-hidden. undefined = nothing refused.
 */
export function unhideError(
  r: NodeBatchResult,
  asked: number,
  listed: HiddenNode[]
): string | undefined {
  if (r.ok) return undefined
  if (asked === 1) return r.error
  const named = (id: number) => {
    const name = listed.find((n) => n.nodeId === id)?.name
    return name ? `#${id} ${name}` : `#${id}`
  }
  return `Couldn’t un-hide ${r.failed.map((f) => `${named(f.nodeId)}: ${f.error}`).join('; ')}`
}

/**
 * When Reset…'s review asks main for its preview again (R9): the preview is built from the node
 * mapping, so this is the mapping as the snapshot shows it — every board's name, console, PDU and
 * where it came from, the hidden ones included, and how many differ. A push that changes none of
 * it (a roster poll, a PDU page) gives the same key, and the review keeps the preview it has.
 */
export function resetPreviewKey(s: CockpitSnapshot): string {
  const boards = s.views.map(({ entry: e }) => [e.nodeId, e.source, e.name, e.console, e.pduId])
  const hidden = s.settings.hidden.map((h) => [h.nodeId, h.source, h.name, h.console, h.pduId])
  return JSON.stringify([s.settings.differing, boards, hidden])
}
