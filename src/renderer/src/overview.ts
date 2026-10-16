// Overview (#65): the pure decisions behind the Cockpit tile, the Attention banner and the
// new-devices notice. All of it is read off the Cockpit's own picture (`healthBand`,
// `attentionItems`); the client adds no thresholds of its own.
import type { NodeModelEntry } from '@shared/node-rules'
import type { AttentionItem, HealthBand, NodeView } from './cockpit'

// ── Cockpit tile ────────────────────────────────────────────────────────────

export interface CockpitTile {
  value: string
  sub: string
  /** Worst state among known nodes, drawn as its symbol before the value. Healthy = none. */
  symbol?: 'off' | 'warn'
  /** ok = all up and healthy; issue = something offline or warning; none = no live status. */
  tone: 'ok' | 'issue' | 'none'
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** `37 / 40` nodes up, total W the client computes and the PDUs on the plan. */
export function cockpitTile(band: HealthBand, live: boolean): CockpitTile {
  if (!live) return { value: '—', sub: 'no live node status', tone: 'none' }
  if (band.total === 0) return { value: '—', sub: 'no nodes known', tone: 'none' }
  if (band.unknown === band.total) return { value: '—', sub: 'no status yet', tone: 'none' }
  const pdus = band.pdusWith + band.pdusWithout
  const sub = [
    'nodes up',
    band.watts === null ? '— W' : `${band.watts.toFixed(1)} W`,
    ...(pdus ? [plural(pdus, 'PDU')] : [])
  ].join(' · ')
  const symbol = band.off > 0 ? 'off' : band.warn > 0 ? 'warn' : undefined
  return {
    value: `${band.online} / ${band.total}`,
    sub,
    symbol,
    tone: symbol ? 'issue' : band.unknown > 0 ? 'none' : 'ok'
  }
}

// ── Attention banner ────────────────────────────────────────────────────────

/** How many names the banner lists per kind before "+N more". */
export const BANNER_NAMES = 3

export interface AttentionSummary {
  /** `8 nodes need attention` */
  head: string
  /** `3 offline (Left_Oxygen, Right_TACAN, Center_Clock) · 5 warnings` */
  detail: string
}

/** A PDU outage reads as the PDU plus the nodes that dropped with it. */
const itemName = (i: AttentionItem) =>
  i.outage ? `${i.name} + ${plural(i.outage.nodeIds.length, 'node')}` : i.name

function names(items: AttentionItem[]): string {
  const shown = items.slice(0, BANNER_NAMES).map(itemName)
  const more = items.length - shown.length
  return `(${shown.join(', ')}${more > 0 ? ` +${more} more` : ''})`
}

/**
 * The banner while a board reports a problem; null when none does. Counts every known node that
 * is offline or warning (a PDU outage counts each node in it) and names the most severe kind
 * present — the offline ones, else the warnings — in Attention order.
 */
export function attentionSummary(
  band: HealthBand,
  items: AttentionItem[]
): AttentionSummary | null {
  const n = band.off + band.warn
  if (n === 0 || items.length === 0) return null
  const off = items.filter((i) => i.state === 'off')
  const warn = items.filter((i) => i.state === 'warn')
  const parts: string[] = []
  if (band.off > 0) parts.push(`${band.off} offline ${names(off)}`)
  if (band.warn > 0) {
    const w = plural(band.warn, 'warning')
    parts.push(band.off > 0 ? w : `${w} ${names(warn)}`)
  }
  return {
    head: `${plural(n, 'node')} need${n === 1 ? 's' : ''} attention`,
    detail: parts.join(' · ')
  }
}

// ── New devices ─────────────────────────────────────────────────────────────

/**
 * The kind a node has reported itself. Never inferred from its NODE_ID: today only PDU telemetry
 * pages say anything (a new node is 'pdu' only after it sent one); firmware #344 adds a reported
 * kind for panel groups too. null = not reported yet.
 */
export function reportedKind(e: NodeModelEntry): 'pdu' | 'panel' | null {
  return e.kind === 'pdu' && e.everHadReadings ? 'pdu' : null
}

export interface NewDevices {
  count: number
  panels: number
  pdus: number
  /** Not reported a kind yet: neither a panel group nor a PDU as far as the client knows. */
  unidentified: number
}

/** NODE_IDs waiting to be adopted, by the kind each reported. null = none waiting. */
export function newDevices(views: NodeView[]): NewDevices | null {
  const fresh = views.filter((v) => v.entry.source === 'new')
  if (fresh.length === 0) return null
  const kinds = fresh.map((v) => reportedKind(v.entry))
  const panels = kinds.filter((k) => k === 'panel').length
  const pdus = kinds.filter((k) => k === 'pdu').length
  return { count: fresh.length, panels, pdus, unidentified: fresh.length - panels - pdus }
}

/** `2 new devices on the bus` + `1 PDU, 1 not identified yet, not in NODE_IDS.md.` */
export function newDevicesText(d: NewDevices): { head: string; detail: string } {
  const parts = [
    ...(d.panels ? [plural(d.panels, 'panel group')] : []),
    ...(d.pdus ? [plural(d.pdus, 'PDU')] : []),
    ...(d.unidentified ? [`${d.unidentified} not identified yet`] : [])
  ]
  // None identified: no count to repeat ("2 new devices on the bus — not identified yet, …").
  const kinds = d.unidentified === d.count ? 'not identified yet' : parts.join(', ')
  return {
    head: `${plural(d.count, 'new device')} on the bus`,
    detail: `${kinds}, not in NODE_IDS.md.`
  }
}
