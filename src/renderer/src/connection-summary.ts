// Connection › Connected nodes (#66): the pure decisions behind the summary card. Counts and the
// most severe nodes come from the same helpers as the Cockpit health band and Attention, so the
// two tabs always agree; the full picture lives in the Cockpit tab.
import type { PduOutage } from '@shared/nodes/ipc'
import {
  affected,
  ATTENTION_SHOWN,
  attentionItems,
  healthBand,
  lastSeenLabel,
  type NodeState,
  type NodeView
} from './cockpit'
import { fmtTime } from './store'

export interface SummaryRow {
  nodeId: number
  name: string
  state: NodeState
  /** Chip text: `OFFLINE`, `BUS-OFF`, or the flags the board raised. */
  chip: string
  tone: 'err' | 'warn'
  /**
   * `#13 · PDU_Left · offline since 21:11:18`, or for a board remembered from an earlier session
   * that hasn't reported since the link opened, `… · not seen this session · last seen 14 Oct,
   * 21:13` — "offline since" would be the roster's time, not when it went (#93).
   */
  meta: string
}

export interface NodesSummary {
  /** Known nodes (registry + adopted, PDUs included); new nodes are not counted. */
  known: number
  healthy: number
  warn: number
  off: number
  /** No complete roster yet and not reported. */
  unknown: number
  /** Known nodes that are PDUs, by their kind (never by NODE_ID). */
  pdus: number
  /** Client-computed total over PDUs with fresh readings; null = none has any. */
  watts: number | null
  /** The most severe nodes, in Cockpit Attention order. */
  rows: SummaryRow[]
  /** Attention items not shown. */
  more: number
  /** `+5 more · healthy nodes hidden`; empty when there is nothing to say. */
  footer: string
}

const clock = (ms: number) => fmtTime(ms).slice(0, 8)

export function nodesSummary(views: NodeView[], outages: PduOutage[]): NodesSummary {
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
      const feed = e.pduId === null ? undefined : byId.get(e.pduId)
      meta.push(feed ? feed.name : 'no power zone')
    }
    if (e.notSeen) {
      meta.push('not seen this session')
      if (e.lastSeenAt !== undefined) meta.push(`last seen ${lastSeenLabel(e.lastSeenAt)}`)
    } else if (e.availability === 'offline' && e.offlineAt !== undefined) {
      meta.push(`offline since ${clock(e.offlineAt)}`)
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
