// Cockpit › Attention (moved from the renderer, R3.2): which boards are items and in what order,
// the strays (new boards that can't be adopted), the Gateway's own item, the cap and the "New on
// the bus" count.
import type { GatewayStatus } from '@shared/gateway'
import type {
  AttentionItem,
  CockpitAttention,
  NodeModel,
  NodeModelEntry,
  NodeView,
  PduOutage,
  StrayItem
} from '@shared/nodes'
import { lastSeenLabel } from '@shared/format'
import { shownHealth } from '../../gateway'
import { isReportableNew, newState, strayKind } from '../node-model'

/** "1 node affected" / "3 nodes affected" — a PDU outage, wherever it is shown. */
export function affected(n: number): string {
  return `${n} node${n === 1 ? '' : 's'} affected`
}

/**
 * Most severe first: PDU outages, then offline (incl. bus-off), then warnings — each by NODE_ID.
 * Nodes that dropped with their PDU are folded into its outage item. New boards that can be
 * adopted have their own prompt; ones that can't (`strays`) are warnings, after the rest. A PDU
 * without readings is not an issue (its panel explains).
 */
export function attentionItems(
  views: NodeView[],
  outages: PduOutage[],
  strays: StrayItem[] = []
): AttentionItem[] {
  const folded = new Set(outages.flatMap((o) => o.nodeIds))
  const items: (AttentionItem & { rank: number })[] = []
  for (const v of views) {
    const { state, flag } = v.health
    if (state !== 'off' && state !== 'warn') continue
    const outage = outages.find((o) => o.pduId === v.entry.nodeId)
    if (!outage && folded.has(v.entry.nodeId)) continue
    const e = v.entry
    const seen =
      e.notSeen && e.lastSeenAt !== undefined ? ` · last seen ${lastSeenLabel(e.lastSeenAt)}` : ''
    items.push({
      key: `n-${e.nodeId}`,
      nodeId: e.nodeId,
      name: e.name,
      state,
      flag: outage ? `OFFLINE · ${affected(outage.nodeIds.length)}` : `${flag ?? ''}${seen}`,
      outage,
      rank: outage ? 0 : state === 'off' ? 1 : 2
    })
  }
  for (const s of strays) {
    items.push({
      key: `s-${s.nodeId}`,
      nodeId: s.nodeId,
      name: `NODE_ID ${s.nodeId}`,
      state: 'warn',
      flag: s.flag,
      stray: true,
      rank: 3
    })
  }
  return items
    .sort((a, b) => a.rank - b.rank || a.nodeId - b.nodeId)
    .map(({ rank: _rank, ...i }) => i)
}

/** How many Attention items show before "+N more". */
export const ATTENTION_SHOWN = 3

/**
 * "New on the bus · N": new NODE_IDs on the bus now that have identified as a PDU or a panel group.
 * One still identifying is not news yet, and with the link down none is on the bus now
 * (isReportableNew — the Overview's notice agrees).
 */
export function newCount(model: NodeModel, live: boolean): number {
  return model.nodes.filter((e) => isReportableNew(e, live)).length
}

/** The identify grace (node-model.ts newState), re-exported where the strays are built. */
export { IDENTIFY_WAIT_MS } from '../node-model'

/**
 * The strays (#93, X3): the boards newState calls `stray` — new, on the bus now, and can't be
 * adopted (a kind that can't be, or still unidentified IDENTIFY_WAIT_MS after it came online). One
 * list for every tab: the Cockpit's band and Attention, the Overview's tile and banner, Connection ›
 * Connected nodes. A board on the bus is active, so it can't be hidden — it is a warning instead.
 * None while the link is down. `nextAt` = when one still identifying will cross the line.
 */
export function strayNew(
  views: NodeView[],
  now: number,
  live: boolean
): { strays: NodeView[]; nextAt?: number } {
  const strays: NodeView[] = []
  let nextAt: number | undefined
  for (const v of views) {
    const s = newState(v.entry, now, live)
    if (s?.state === 'stray') strays.push(v)
    else if (s?.state === 'identifying') nextAt = Math.min(nextAt ?? s.strayAt, s.strayAt)
  }
  return nextAt === undefined ? { strays } : { strays, nextAt }
}

/** A stray's Attention line: what it is (node-model.ts strayKind), and that it can't be adopted. */
export function strayFlag(e: NodeModelEntry): string {
  return `${strayKind(e).toUpperCase()} · can’t be adopted`
}

/**
 * The Gateway's own problem (#94), as its Attention item: none while the link is down (the link
 * state says it all — gateway-health's shownHealth) or while it is healthy; err → off, else warn.
 */
function gatewayAttention(
  gateway: GatewayStatus | undefined,
  linkUp: boolean
): CockpitAttention['gateway'] {
  const g = shownHealth(gateway, linkUp)
  if (!g || g.severity === 'ok') return undefined
  return { flag: g.label, state: g.severity === 'err' ? 'off' : 'warn' }
}

/**
 * The Attention card. Items only while the link is up (the strays are on the bus now already,
 * strayNew); the Gateway's item takes a shown slot first; "New on the bus" counts the boards on
 * the bus now (newCount), so it too is quiet while unplugged (X2 / R5).
 */
export function cockpitAttention(
  model: NodeModel | undefined,
  views: NodeView[],
  outages: PduOutage[],
  strays: StrayItem[],
  live: boolean,
  gatewayStatus: GatewayStatus | undefined
): CockpitAttention {
  const items = live ? attentionItems(views, outages, strays) : []
  const gateway = gatewayAttention(gatewayStatus, live)
  const count = items.length + (gateway ? 1 : 0)
  const out: CockpitAttention = {
    items,
    shown: items.slice(0, ATTENTION_SHOWN - (gateway ? 1 : 0)),
    count,
    more: Math.max(0, count - ATTENTION_SHOWN),
    newCount: model ? newCount(model, live) : 0
  }
  if (gateway) out.gateway = gateway
  return out
}
