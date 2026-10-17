// Settings wording (#67), pure so it is unit-tested: what each Cockpit / Import row says. The
// registry rows and Reset…'s gate are main's (cockpit:snapshot settings, R3.2b).
import { day, hhmm, plural } from '@shared/format'
import type { HiddenNode } from '@shared/nodes'
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

/** Import review subtitle: "skyhawk-config.json · exported 2026-10-12 21:02 · client v0.2.0". */
export function importSubtitle(p: {
  fileName: string
  exportedAt?: string
  client?: string
}): string {
  const parts = [p.fileName]
  const t = p.exportedAt ? Date.parse(p.exportedAt) : NaN
  if (!Number.isNaN(t)) parts.push(`exported ${day(t)} ${hhmm(t)}`)
  if (p.client) parts.push(`client v${p.client}`)
  return parts.join(' · ')
}

/** A review row's key: calibration rows name the axis, and the board when there are several. */
export function importRowKey(
  r: { k: string; axis?: number; board?: string },
  axisLabels: readonly string[],
  severalBoards: boolean
): string {
  if (r.axis === undefined) return r.k
  const name = axisLabels[r.axis] ?? r.k
  return severalBoards && r.board ? `${name} · ${r.board}` : name
}

/** "Applied 1 section" / "Applied 3 sections · backup saved as skyhawk-config-….json". */
export function importDoneText(applied: number, backupPath?: string): string {
  const done = `Applied ${plural(applied, 'section')}`
  return backupPath ? `${done} · backup saved as ${backupPath.split(/[/\\]/).pop()}` : done
}
