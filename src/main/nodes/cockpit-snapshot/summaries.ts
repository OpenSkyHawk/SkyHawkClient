// The Overview's and Connection's reading of the Cockpit's picture (moved from the renderer,
// R3.2b): the Overview's Cockpit tile, its
// Attention banner and new-devices notice, and Connection › Connected nodes. The client adds no
// thresholds of its own.
//
// Each keeps its own answer where it differs from the Cockpit's (co-located, not unified):
//   X3 strays   neither counts a new board that can't be adopted: the band is healthBand(views)
//               with no strays, the items attentionItems(views, outages) with none
//   X2 link     the banner and the notice only while the link is up (the tile says "no live node
//               status"); Connected nodes reads the last model whatever the link (its tab shows
//               the link's hint instead while it is down)
//   X4 zone     a Connected nodes row names the PDU its zone says, wherever that PDU is — on the
//               plan, new on the bus, or hidden (still in your cockpit, X1: members.ts) — else
//               "no power zone"
import { hhmmss, lastSeenLabel, plural } from '@shared/format'
import type {
  AttentionItem,
  AttentionSummary,
  CockpitTile,
  HealthBand,
  NewDevices,
  NodeModelEntry,
  NodesSummary,
  NodeView,
  OverviewSummary,
  PduOutage,
  SummaryRow
} from '@shared/nodes'
import { isAdoptableKind } from '../node-kind'
import { isReportableNew } from '../node-model'
import { affected, ATTENTION_SHOWN, attentionItems } from './attention'
import { healthBand } from './band'
import type { Members } from './members'

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
 * The Overview's tile, banner and notice, as the Overview tab computed them: the band and the items
 * without strays (X3), the banner and the notice only while the link is up.
 */
export function overviewSummary(
  views: NodeView[],
  outages: PduOutage[],
  live: boolean
): OverviewSummary {
  const band = healthBand(views)
  return {
    tile: cockpitTile(band, live),
    banner: live ? attentionSummary(band, attentionItems(views, outages)) : null,
    newDevices: newDevices(views, live)
  }
}

// ── Connection › Connected nodes ────────────────────────────────────────────

export function nodesSummary(
  views: NodeView[],
  outages: PduOutage[],
  members: Members
): NodesSummary {
  const band = healthBand(views)
  const known = views.filter((v) => v.entry.source !== 'new')
  const byId = new Map(views.map((v) => [v.entry.nodeId, v.entry]))
  const items = attentionItems(views, outages)
  const healthy = band.online - band.warn

  const rows = items.slice(0, ATTENTION_SHOWN).map((i): SummaryRow => {
    const e = byId.get(i.nodeId)!
    const meta = [`#${i.nodeId}`]
    if (i.outage) meta.push(affected(i.outage.nodeIds.length))
    else if (e.kind !== 'pdu') {
      const feed = e.pduId === null ? undefined : (byId.get(e.pduId) ?? members.get(e.pduId))
      meta.push(feed ? feed.name : 'no power zone')
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
    known: known.length,
    healthy,
    warn: band.warn,
    off: band.off,
    unknown: band.unknown,
    pdus: known.filter((v) => v.entry.kind === 'pdu').length,
    watts: band.watts,
    rows,
    more,
    footer
  }
}
