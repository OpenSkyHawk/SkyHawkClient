// The Overview's and Connection's copy of the Cockpit's picture (#63, #65, #66): node views, the
// health band and Attention, computed here from `nodes:model` / `nodes:telemetry` until R3.2b moves
// those surfaces onto main's snapshot too. The Cockpit tab itself reads `cockpit:snapshot`, built
// in main (nodes/cockpit-snapshot) from the same code. The client applies no thresholds — a warning
// is always a flag a board raised itself.
import { lastSeenLabel } from '@shared/format'
import type {
  AttentionItem,
  HealthBand,
  NodeHealth,
  NodeModel,
  NodeModelEntry,
  NodeTelemSnapshot,
  NodeView,
  PduOutage,
  PduRailPage,
  PduReadings,
  StrayItem
} from '@shared/nodes'
import { displayCurrentMa, nodeFaultTag, PDU_FLAG, RAIL_FLAG } from '@shared/nodes/legacy-rules'

// Connection's tests read the symbols from here, as before (node-view.ts owns them).
export { STATE_SYMBOL } from './node-view'
export type {
  AttentionItem,
  HealthBand,
  NodeHealth,
  NodeState,
  NodeView,
  PduReadings,
  StrayItem
} from '@shared/nodes'

/** A PDU's pages that are fresh right now. A stale page is not a reading. */
export function freshReadings(t: NodeTelemSnapshot | undefined): PduReadings {
  const r: PduReadings = {}
  if (t?.rail12V && !t.rail12V.stale) r.rail12V = t.rail12V
  if (t?.rail5V && !t.rail5V.stale) r.rail5V = t.rail5V
  if (t?.status && !t.status.stale) r.status = t.status
  return r
}

const RAIL_FLAG_TEXT: [number, string][] = [
  [RAIL_FLAG.UNDER_V, 'UNDER-V'],
  [RAIL_FLAG.OVER_V, 'OVER-V'],
  [RAIL_FLAG.OVER_CURRENT, 'OVER-I'],
  [RAIL_FLAG.FUSE_OPEN, 'FUSE OPEN'],
  [RAIL_FLAG.SENSOR_FAULT, 'SENSOR FAULT']
]
/** Status flags that are alerts. UNCAL_VDDA / UNCAL_ZERO are calibration state, not alerts. */
const STATUS_FLAG_TEXT: [number, string][] = [
  [PDU_FLAG.TEMP_CRIT, 'TEMP CRIT'],
  [PDU_FLAG.TEMP_WARN, 'TEMP WARN'],
  [PDU_FLAG.NTC_FAULT, 'NTC FAULT']
]

/** The alert flags a PDU raises on its fresh pages, e.g. `5V UNDER-V`. Empty = healthy. */
export function pduAlertFlags(r: PduReadings): string[] {
  const out: string[] = []
  const rail = (label: string, p?: PduRailPage) => {
    for (const [bit, text] of RAIL_FLAG_TEXT) if (p && p.flags & bit) out.push(`${label} ${text}`)
  }
  rail('12V', r.rail12V)
  rail('5V', r.rail5V)
  for (const [bit, text] of STATUS_FLAG_TEXT) if (r.status && r.status.flags & bit) out.push(text)
  return out
}

/** Offline wins, then bus-off, then any flag the node (or, for a PDU, its pages) raised. */
export function nodeHealth(e: NodeModelEntry, r: PduReadings = {}): NodeHealth {
  if (e.source === 'new') return { state: 'new', flag: 'NOT IN REGISTRY' }
  if (e.availability === 'unknown') return { state: 'unknown' }
  if (e.notSeen) return { state: 'off', flag: 'NOT SEEN THIS SESSION' }
  if (e.availability === 'offline') return { state: 'off', flag: 'OFFLINE' }
  const st = e.status
  if (st?.boff) return { state: 'off', flag: 'BUS-OFF' }
  const flags: string[] = []
  if (st?.degraded) flags.push(nodeFaultTag(st))
  if (st?.overheat) flags.push('OVERHEAT')
  if (st?.epvf) flags.push('ERR-PASSIVE')
  if (e.kind === 'pdu') flags.push(...pduAlertFlags(r))
  return flags.length ? { state: 'warn', flag: flags.join(' · ') } : { state: 'on' }
}

export function nodeViews(model: NodeModel, telemetry: NodeTelemSnapshot[]): NodeView[] {
  const telem = new Map(telemetry.map((t) => [t.nodeId, t]))
  return model.nodes.map((entry) => {
    // An offline PDU has no readings, even in the seconds before its last pages go stale.
    const readings =
      entry.kind === 'pdu' && entry.availability === 'online'
        ? freshReadings(telem.get(entry.nodeId))
        : {}
    return {
      entry,
      health: nodeHealth(entry, readings),
      readings,
      noReadings: entry.kind === 'pdu' && entry.readings === 'none'
    }
  })
}

// ── Attention ───────────────────────────────────────────────────────────────

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

// ── health band ─────────────────────────────────────────────────────────────

const railW = (p?: PduRailPage) => (p ? (p.vAvgMv / 1000) * (displayCurrentMa(p.iAvgMa) / 1000) : 0)

/**
 * Total W the client computes from the fresh rails (V × A per rail). null = no readings at all.
 * Placed nodes only: a PDU still waiting in "New on the bus" reports readings but is not on the
 * plan, and the Total card and its session peak must add up the same PDUs.
 */
export function totalWatts(views: NodeView[]): number | null {
  let w: number | null = null
  for (const v of views) {
    if (v.entry.source === 'new') continue
    const { rail12V, rail5V } = v.readings
    if (rail12V || rail5V) w = (w ?? 0) + railW(rail12V) + railW(rail5V)
  }
  return w
}

export function healthBand(views: NodeView[], strays = 0): HealthBand {
  const known = views.filter((v) => v.entry.source !== 'new')
  const pdus = known.filter((v) => v.entry.kind === 'pdu')
  const b: HealthBand = {
    online:
      known.filter((v) => v.health.state === 'on' || v.health.state === 'warn').length + strays,
    total: known.length + strays,
    warn: known.filter((v) => v.health.state === 'warn').length + strays,
    off: known.filter((v) => v.health.state === 'off').length,
    unknown: known.filter((v) => v.health.state === 'unknown').length,
    amps12: null,
    amps5: null,
    watts12: null,
    watts: totalWatts(known),
    pdusWithout: 0,
    pdusWith: 0,
    busOff: 0
  }
  const add = (cur: number | null, ma: number) => (cur ?? 0) + displayCurrentMa(ma) / 1000
  for (const p of pdus) {
    const { rail12V, rail5V, status } = p.readings
    if (rail12V || rail5V || status) b.pdusWith++
    else b.pdusWithout++
    if (rail12V) {
      b.amps12 = add(b.amps12, rail12V.iAvgMa)
      b.watts12 = (b.watts12 ?? 0) + railW(rail12V)
    }
    if (rail5V) {
      b.amps5 = add(b.amps5, rail5V.iAvgMa)
      const volts = rail5V.vAvgMv / 1000
      if (!b.low5 || volts < b.low5.volts) {
        b.low5 = { volts, nodeId: p.entry.nodeId, name: p.entry.name }
      }
    }
    if (status && status.ntcTempC !== null && (!b.hottest || status.ntcTempC > b.hottest.tempC)) {
      b.hottest = {
        tempC: status.ntcTempC,
        nodeId: p.entry.nodeId,
        name: p.entry.name,
        level:
          status.flags & PDU_FLAG.TEMP_CRIT
            ? 'crit'
            : status.flags & PDU_FLAG.TEMP_WARN
              ? 'warn'
              : 'ok'
      }
    }
  }
  for (const v of known) {
    const st = v.entry.status
    if (v.entry.availability !== 'online' || !st) continue
    if (st.boff) {
      b.busOff++
      b.busOffBoard ??= { nodeId: v.entry.nodeId, name: v.entry.name }
    }
    const worst = b.worstCan ? Math.max(b.worstCan.tec, b.worstCan.rec) : -1
    if (Math.max(st.tec, st.rec) > worst) {
      b.worstCan = { tec: st.tec, rec: st.rec, nodeId: v.entry.nodeId, name: v.entry.name }
    }
  }
  return b
}
