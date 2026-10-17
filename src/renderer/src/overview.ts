// Overview (#65): the pure decisions behind the Cockpit tile, the Attention banner and the
// new-devices notice. All of it is read off the Cockpit's own picture (`healthBand`,
// `attentionItems`); the client adds no thresholds of its own.
import { isAdoptableKind } from '@shared/node-kind'
import { isReportableNew } from '@shared/node-rules'
import type { NodeModelEntry } from '@shared/nodes/ipc'
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
 * The adoptable kind a node has identified as (node-kind.ts resolveKind: its own announcement, PDU
 * telemetry, then what was stored). Never inferred from its NODE_ID. null = not identified yet, or a
 * kind that can't be adopted (a bridge, or one this client doesn't know).
 */
export function reportedKind(e: NodeModelEntry): 'pdu' | 'panel' | null {
  return isAdoptableKind(e.identified) ? e.identified : null
}

export interface NewDevices {
  count: number
  panels: number
  pdus: number
  /** Of them, boards in NODE_IDS.md waiting to be added (#93: pre-filled in New on the bus). */
  registry: number
}

/**
 * NODE_IDs waiting to be adopted that are on the bus now and have said what they are, by kind.
 * A node is not news until it has identified itself (no "unknown" count), and one that left the
 * bus is not "on the bus". null = nothing to show, including while the link is down.
 */
export function newDevices(views: NodeView[], live: boolean): NewDevices | null {
  if (!live) return null
  const fresh = views.filter((v) => isReportableNew(v.entry))
  const kinds = fresh.map((v) => reportedKind(v.entry))
  const panels = kinds.filter((k) => k === 'panel').length
  const pdus = kinds.filter((k) => k === 'pdu').length
  const registry = fresh.filter((v) => v.entry.registry).length
  return panels + pdus ? { count: panels + pdus, panels, pdus, registry } : null
}

/**
 * `2 new devices on the bus` + what they are. Since #93 a registry board is new too until you add
 * it: `1 panel group from NODE_IDS.md, not added to your cockpit yet.`; unregistered ones are
 * `… not in NODE_IDS.md.`; a mix says how many are from NODE_IDS.md.
 */
export function newDevicesText(d: NewDevices): { head: string; detail: string } {
  const kinds = [
    ...(d.panels ? [plural(d.panels, 'panel group')] : []),
    ...(d.pdus ? [plural(d.pdus, 'PDU')] : [])
  ].join(', ')
  const detail =
    d.registry === 0
      ? `${kinds}, not in NODE_IDS.md.`
      : d.registry === d.count
        ? `${kinds} from NODE_IDS.md, not added to your cockpit yet.`
        : `${kinds}, not added to your cockpit yet — ${d.registry} from NODE_IDS.md.`
  return { head: `${plural(d.count, 'new device')} on the bus`, detail }
}
