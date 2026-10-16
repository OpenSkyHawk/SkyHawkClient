// Settings text decisions (#67), pure so they are unit-tested: what each Cockpit / About row says.
import type { NodeRegistryInfo } from '@shared/ipc'
import type { NodeKind } from '@shared/node-mapping'
import type { HiddenNode, IgnoredNode, NodeModel } from '@shared/node-rules'
import { consoleLabel } from '../../cockpit-panels'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const kindLabel = (k: NodeKind | undefined) =>
  k === 'pdu' ? 'PDU' : k === 'panel' ? 'Panel group' : 'Unknown kind'

const pad = (n: number) => String(n).padStart(2, '0')
/** Local YYYY-MM-DD. */
const day = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const clock = (t: number) => {
  const d = new Date(t)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

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

export interface IgnoredRow {
  nodeId: number
  label: string
  desc: string
}

/** One Ignored nodes row. Last seen is this session only, and says so when it does not know. */
export function ignoredRow(n: IgnoredNode, now = Date.now()): IgnoredRow {
  const kind = kindLabel(n.kind)
  const ignored = n.ignoredAt ? `ignored ${day(Date.parse(n.ignoredAt))}` : 'ignored earlier'
  const seen =
    n.lastSeen === 'now'
      ? 'on the bus now'
      : n.lastSeen === undefined
        ? 'not seen this session'
        : `offline since ${day(n.lastSeen) === day(now) ? clock(n.lastSeen) : day(n.lastSeen)}`
  return {
    nodeId: n.nodeId,
    label: n.name ? `${n.name} · ${kind}` : kind,
    desc: `${ignored} · ${seen}`
  }
}

/** One Hidden nodes row (#76): the name and console the Cockpit showed for it. */
export function hiddenRow(n: HiddenNode): IgnoredRow {
  return {
    nodeId: n.nodeId,
    label: n.name,
    desc: n.console
      ? `${consoleLabel(n.console)} · returns when it reports again`
      : 'returns when it reports again'
  }
}

/** "NODE_IDS.md · 6 nodes: 3 PDUs, 2 panel groups, PanelBridge". */
export function registrySummary(r: NodeRegistryInfo): string {
  const pdus = r.nodes.filter((n) => n.kind === 'pdu').length
  const panels = r.nodes.filter((n) => n.kind === 'panel').length
  const parts = [plural(pdus, 'PDU'), plural(panels, 'panel group')]
  if (r.nodes.some((n) => n.kind === 'bridge')) parts.push('PanelBridge')
  const file = r.file.split('/').pop()
  return `${file} · ${plural(r.nodes.length, 'node')}: ${parts.join(', ')}`
}

export type OnBus = { text: string; dot: 'on' | 'off' | '' }

/**
 * Registry list "On the bus" column. PanelBridge is the serial link itself; a CAN node is what
 * the roster says — "—" before any roster, since that is no data rather than "absent".
 */
export function registryOnBus(
  nodeId: number,
  model: NodeModel | undefined,
  linkUp: boolean
): OnBus {
  if (nodeId === 0)
    return linkUp ? { text: 'serial link', dot: 'on' } : { text: 'no device', dot: '' }
  if (model?.ignored.includes(nodeId)) return { text: 'ignored', dot: '' }
  if (model?.hidden.includes(nodeId)) return { text: 'hidden', dot: '' }
  const e = model?.nodes.find((n) => n.nodeId === nodeId)
  if (e?.availability === 'online') return { text: 'yes', dot: 'on' }
  if (e?.availability === 'offline') return { text: 'offline', dot: 'off' }
  return { text: '—', dot: '' }
}

/** Import review subtitle: "skyhawk-config.json · exported 2026-10-12 21:02 · client v0.2.0". */
export function importSubtitle(p: {
  fileName: string
  exportedAt?: string
  client?: string
}): string {
  const parts = [p.fileName]
  const t = p.exportedAt ? Date.parse(p.exportedAt) : NaN
  if (!Number.isNaN(t)) parts.push(`exported ${day(t)} ${clock(t)}`)
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
