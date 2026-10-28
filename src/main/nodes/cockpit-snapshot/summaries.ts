// The Overview's and Connection's reading of the Cockpit's picture (moved from the renderer,
// R3.2b): the Overview's Cockpit tile, its
// Attention banner and new-devices notice, and Connection › Connected nodes. The client adds no
// thresholds of its own.
//
// Both count what the Cockpit counts (X3): its views and its strays — the new boards that can't be
// adopted (node-model.ts newState), each one a board up and a warning, and an Attention item.
// What is on the bus is one rule (node-model.ts onBusNow, X2): while the link is down the tile says
// "no live node status", and the banner, the notice and Connected nodes say nothing.
// With none of your cockpit's boards to count, Connected nodes points to the new ones on the bus
// (#160): the same count as the Overview's notice and the Cockpit's "New on the bus".
// A Connected nodes row names its board's resolved power zone (D7, the same one the Cockpit reads):
// `PDU_Right`, `PDU_Right (hidden)`, else "no power zone".
import { hhmmss, lastSeenLabel, plural } from '@shared/format'
import {
  COCKPIT_IDLE,
  NO_NODES,
  type AttentionItem,
  type AttentionSummary,
  type CockpitTile,
  type HealthBand,
  type NewDevices,
  type NodeModelEntry,
  type NodesSummary,
  type NodeView,
  type OverviewSummary,
  type PduOutage,
  type PowerZone,
  type StrayItem,
  type SummaryRow
} from '@shared/nodes'
import { isAdoptableKind } from '../node-kind'
import { isReportableNew } from '../node-model'
import { affected, ATTENTION_SHOWN, attentionItems } from './attention'
import { healthBand } from './band'

// ── Overview › Cockpit tile ─────────────────────────────────────────────────

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

// ── Overview › Attention banner ─────────────────────────────────────────────

/** How many names the banner lists per kind before "+N more". */
const BANNER_NAMES = 3

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

// ── Overview › new devices ──────────────────────────────────────────────────

/**
 * The adoptable kind a node has identified as (node-kind.ts identityOf: its own announcement, PDU
 * telemetry, then what was stored). Never inferred from its NODE_ID. null = not identified yet, or a
 * kind that can't be adopted (a bridge, or one this client doesn't know).
 */
export function reportedKind(e: NodeModelEntry): 'pdu' | 'panel' | null {
  return isAdoptableKind(e.identified) ? e.identified : null
}

/**
 * NODE_IDs waiting to be adopted that are on the bus now and have said what they are, by kind.
 * A node is not news until it has identified itself (no "unknown" count), and one that left the
 * bus — or any, while the link is down — is not "on the bus" (isReportableNew). null = nothing to
 * show.
 */
export function newDevices(views: NodeView[], live: boolean): NewDevices | null {
  const fresh = views.filter((v) => isReportableNew(v.entry, live))
  const kinds = fresh.map((v) => reportedKind(v.entry))
  const panels = kinds.filter((k) => k === 'panel').length
  const pdus = kinds.filter((k) => k === 'pdu').length
  const registry = fresh.filter((v) => v.entry.registry).length
  return panels + pdus ? { count: panels + pdus, panels, pdus, registry } : null
}

/**
 * The Overview's tile, banner and notice: the band and the items with the Cockpit's strays (X3),
 * the banner and the notice only while the link is up. The firmware banner is firmware-sheet.ts's.
 */
export function overviewSummary(
  views: NodeView[],
  outages: PduOutage[],
  strays: StrayItem[],
  live: boolean
): Omit<OverviewSummary, 'firmware'> {
  const band = healthBand(views, strays.length)
  return {
    tile: cockpitTile(band, live),
    banner: live ? attentionSummary(band, attentionItems(views, outages, strays)) : null,
    newDevices: newDevices(views, live)
  }
}

// ── Connection › Connected nodes ────────────────────────────────────────────

/**
 * The card's line with no board of your cockpit to count: the new boards on the bus and where to
 * add them (#160) — `1 new board on the bus — add it from the Cockpit.` — else that the bus
 * reports nothing.
 */
function emptyLine(newCount: number): string {
  if (newCount === 0) return NO_NODES
  return `${plural(newCount, 'new board')} on the bus — add ${newCount === 1 ? 'it' : 'them'} from the Cockpit.`
}

/**
 * Connected nodes: the counts and the rows that need attention, the Cockpit's strays included (X3:
 * each one a board up and a warning, with its Attention row). Quiet while the link is down — it
 * says nothing about the bus then (X2), and its tab shows the link's hint instead.
 */
export function nodesSummary(
  views: NodeView[],
  outages: PduOutage[],
  strays: StrayItem[],
  zones: ReadonlyMap<number, PowerZone>,
  live: boolean
): NodesSummary {
  if (!live) return COCKPIT_IDLE.nodesCard
  const band = healthBand(views, strays.length)
  const known = views.filter((v) => v.entry.source !== 'new')
  const byId = new Map(views.map((v) => [v.entry.nodeId, v.entry]))
  const items = attentionItems(views, outages, strays)
  const healthy = band.online - band.warn
  // The Overview's notice's count (the Cockpit's "New on the bus · N"): one rule, isReportableNew.
  const newCount = newDevices(views, live)?.count ?? 0

  const rows = items.slice(0, ATTENTION_SHOWN).map((i): SummaryRow => {
    const e = byId.get(i.nodeId)!
    const meta = [`#${i.nodeId}`]
    if (i.outage) meta.push(affected(i.outage.nodeIds.length))
    else if (e.kind !== 'pdu' && !i.stray) {
      const zone = zones.get(e.nodeId)
      meta.push(zone && zone.status !== 'none' ? zone.label : 'no power zone')
    }
    if (e.notSeen) {
      meta.push('not seen this session')
      if (e.lastSeenAt !== undefined) meta.push(`last seen ${lastSeenLabel(e.lastSeenAt)}`)
    } else if (e.availability === 'offline' && e.offlineAt !== undefined) {
      meta.push(`offline since ${hhmmss(e.offlineAt)}`)
    }
    return {
      nodeId: i.nodeId,
      name: i.name,
      state: i.state,
      chip: i.outage || e.notSeen ? 'OFFLINE' : i.flag,
      tone: i.state === 'off' ? 'err' : 'warn',
      meta: meta.join(' · ')
    }
  })

  const more = Math.max(0, items.length - ATTENTION_SHOWN)
  const footer = [
    more > 0 && `+${more} more`,
    band.unknown > 0 && `${band.unknown} no status yet`,
    healthy > 0 && 'healthy nodes hidden'
  ]
    .filter(Boolean)
    .join(' · ')

  return {
    // The strays are boards on the bus too: counted like the Cockpit's band (its total).
    known: band.total,
    healthy,
    warn: band.warn,
    off: band.off,
    unknown: band.unknown,
    pdus: known.filter((v) => v.entry.kind === 'pdu').length,
    watts: band.watts,
    rows,
    more,
    footer,
    newCount,
    empty: emptyLine(newCount)
  }
}
