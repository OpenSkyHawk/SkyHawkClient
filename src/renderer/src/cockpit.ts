// Cockpit tab (#63): the pure decisions behind the health band, the plan and Attention. Everything
// here is computed from what main pushes (`nodes:model`, `nodes:telemetry`); the client applies no
// thresholds — a warning is always a flag a board raised itself.
import {
  isReportableNew,
  type NodeModel,
  type NodeModelEntry,
  type PduOutage
} from '@shared/node-rules'
import {
  PDU_FLAG,
  RAIL_FLAG,
  displayCurrentMa,
  type NodeTelemSnapshot,
  type PduRailPage,
  type PduStatusPage
} from '@shared/node-telem'
import { nodeFaultTag } from '@shared/nodes'
import { PSU_PRESETS, type PsuSetting } from '@shared/psu'

/** How a node reads on the plan. 'unknown' = no complete roster yet and it has not reported. */
export type NodeState = 'on' | 'warn' | 'off' | 'new' | 'unknown'

/** Never colour alone: every state but healthy / unknown carries a symbol. */
export const STATE_SYMBOL: Record<NodeState, string> = {
  on: '',
  warn: '!',
  off: '✕',
  new: '+',
  unknown: ''
}

/** A PDU's pages that are fresh right now. A stale page is not a reading. */
export interface PduReadings {
  rail12V?: PduRailPage
  rail5V?: PduRailPage
  status?: PduStatusPage
}

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

export interface NodeHealth {
  state: NodeState
  /** Short reason shown on Attention and tile tooltips, e.g. `OFFLINE`, `I2C`, `5V UNDER-V`. */
  flag?: string
}

/** Offline wins, then bus-off, then any flag the node (or, for a PDU, its pages) raised. */
export function nodeHealth(e: NodeModelEntry, r: PduReadings = {}): NodeHealth {
  if (e.source === 'new') return { state: 'new', flag: 'NOT IN REGISTRY' }
  if (e.availability === 'unknown') return { state: 'unknown' }
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

/** Everything the tab needs about one node, computed once per push. */
export interface NodeView {
  entry: NodeModelEntry
  health: NodeHealth
  /** PDUs: fresh pages only. */
  readings: PduReadings
  /** PDUs: online but no fresh telemetry. */
  noReadings: boolean
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

// ── search + filter ─────────────────────────────────────────────────────────

/** A tile is lit when it matches the search (name or NODE_ID) and, with Issues on, has one. */
export function tileMatches(v: NodeView, query: string, issuesOnly: boolean): boolean {
  if (issuesOnly && (v.health.state === 'on' || v.health.state === 'unknown')) return false
  const q = query.trim().toLowerCase()
  if (!q) return true
  return v.entry.name.toLowerCase().includes(q) || String(v.entry.nodeId) === q.replace(/^#/, '')
}

// ── plan layout ─────────────────────────────────────────────────────────────

export type ConsoleKey = 'L' | 'C' | 'R'

/** NODE_IDS.md consoles are `Left` / `Center` / `Right`; anything else lands on the panel. */
export function consoleKey(console: string | null): ConsoleKey {
  const c = (console ?? '').toLowerCase()
  if (c.startsWith('left')) return 'L'
  if (c.startsWith('right')) return 'R'
  return 'C'
}

/** Stage geometry, in the 1000-wide stage the plan scales to fit. */
export const STAGE_W = 1000
const MIN_STAGE_H = 600
const CONSOLES: Record<
  ConsoleKey,
  { title: string; x: number; titleY: number; top: number; w: number; cols: number; wide: boolean }
> = {
  L: { title: 'Left console', x: 40, titleY: 164, top: 186, w: 200, cols: 2, wide: false },
  C: { title: 'Instrument panel', x: 290, titleY: 100, top: 122, w: 420, cols: 4, wide: true },
  R: { title: 'Right console', x: 760, titleY: 164, top: 186, w: 200, cols: 2, wide: false }
}
const TILE_GAP = 8
const ROW_H = 42
const HINT_H = 16
const GROUP_GAP = 10

export interface PlanTile {
  view: NodeView
  /** Name without its console prefix (`Left_Fuel` → `Fuel`). */
  short: string
  x: number
  y: number
  w: number
}

export interface PlanGroup {
  key: string
  /** The PDU heading this group; null = nodes with no power zone on this console. */
  pdu: NodeView | null
  console: ConsoleKey
  x: number
  y: number
  w: number
  wide: boolean
  tiles: PlanTile[]
  outage?: PduOutage
  /** Under the tiles of a PDU that went down with its nodes. */
  hint?: { text: string; y: number }
}

export interface PlanWire {
  d: string
  /** The PDU feeding this line raises a rail flag. */
  alert: boolean
}

export interface PlanLayout {
  height: number
  consoles: { key: ConsoleKey; title: string; sub: string; x: number; y: number }[]
  /** Background shapes, sized to the content. */
  sideBox: { y: number; h: number }
  centerBottom: number
  psu: { x: number; y: number }
  groups: PlanGroup[]
  wires: PlanWire[]
}

/** Name without its console prefix (`Left_Fuel` → `Fuel`). */
export const shortName = (name: string) => name.replace(/^(Left|Center|Right)_/, '')

/**
 * What a PDU outage means. A group missing since the link opened was never seen to drop: it may
 * simply not be connected, so the hint does not say it lost power.
 */
export function outageHint(o: PduOutage): string {
  const n = o.nodeIds.length
  const who =
    n === o.fedCount
      ? n === 1
        ? 'The only node'
        : `All ${n} nodes`
      : `${n} of ${o.fedCount} nodes`
  if (o.neverSeen) {
    return `${who} on this PDU and the PDU itself have not been seen since the link opened — not connected, or a blown 5 V fuse at the PDU.`
  }
  const how = n === 1 ? 'lost power with it' : 'lost power together'
  return `${who} on this PDU ${how} — a blown 5 V fuse at the PDU looks like this.`
}

/**
 * One group per PDU on the PDU's console, then the console's nodes without a power zone. A panel
 * sits under the PDU that feeds it, wherever its own console is; new nodes are not placed (they
 * wait in "New on the bus").
 */
export function planLayout(views: NodeView[], outages: PduOutage[]): PlanLayout {
  const pdus = views.filter((v) => v.entry.kind === 'pdu' && v.entry.source !== 'new')
  const pduIds = new Set(pdus.map((p) => p.entry.nodeId))
  const panels = views.filter((v) => v.entry.kind === 'panel' && v.entry.source !== 'new')
  const groups: PlanGroup[] = []
  const bottom: Record<ConsoleKey, number> = { L: 0, C: 0, R: 0 }

  for (const key of ['L', 'C', 'R'] as const) {
    const c = CONSOLES[key]
    const tileW = Math.floor((c.w - TILE_GAP * (c.cols - 1)) / c.cols)
    let y = c.top
    const place = (pdu: NodeView | null, members: NodeView[]) => {
      const outage = pdu ? outages.find((o) => o.pduId === pdu.entry.nodeId) : undefined
      const g: PlanGroup = {
        key: pdu ? `pdu-${pdu.entry.nodeId}` : `none-${key}`,
        pdu,
        console: key,
        x: c.x,
        y,
        w: c.w,
        wide: c.wide,
        tiles: [],
        outage
      }
      y += c.wide ? 30 : 44
      members.forEach((view, i) => {
        g.tiles.push({
          view,
          short: shortName(view.entry.name),
          x: c.x + (i % c.cols) * (tileW + TILE_GAP),
          y: y + Math.floor(i / c.cols) * ROW_H,
          w: tileW
        })
      })
      y += Math.ceil(members.length / c.cols) * ROW_H
      if (outage) {
        g.hint = { text: outageHint(outage), y: y - 4 }
        y += HINT_H
      }
      y += GROUP_GAP
      groups.push(g)
    }
    for (const pdu of pdus.filter((p) => consoleKey(p.entry.console) === key)) {
      place(
        pdu,
        panels.filter((p) => p.entry.pduId === pdu.entry.nodeId)
      )
    }
    const loose = panels.filter(
      (p) =>
        consoleKey(p.entry.console) === key &&
        (p.entry.pduId === null || !pduIds.has(p.entry.pduId))
    )
    if (loose.length) place(null, loose)
    bottom[key] = y
  }

  // Background boxes grow with the content; the PSU sits under the lowest of them.
  const sideBottom = Math.max(530, bottom.L + 14, bottom.R + 14)
  const centerBottom = Math.max(374, bottom.C + 14)
  const psuY = Math.max(548, sideBottom + 18, centerBottom + 18)
  const height = Math.max(MIN_STAGE_H, psuY + 52)
  const psu = { x: 420, y: psuY }

  // One feed line per PDU, gold while it raises a rail flag.
  const wires: PlanWire[] = []
  for (const key of ['L', 'C', 'R'] as const) {
    const on = pdus.filter((p) => consoleKey(p.entry.console) === key)
    on.forEach((p, i) => {
      const off = i - (on.length - 1) / 2
      const alert = railAlert(p.readings)
      if (key === 'C') {
        const x = Math.round(500 + off * 70)
        wires.push({ d: `M${x} ${psuY} V${centerBottom}`, alert })
      } else {
        const x = Math.round((key === 'L' ? 140 : 860) + off * 24)
        const from = key === 'L' ? psu.x : psu.x + 160
        wires.push({ d: `M${from} ${psuY + 18 - i * 8} H${x} V${sideBottom + 2}`, alert })
      }
    })
  }

  const count = (key: ConsoleKey) => pdus.filter((p) => consoleKey(p.entry.console) === key).length
  return {
    height,
    consoles: (['L', 'C', 'R'] as const).map((key) => ({
      key,
      title: CONSOLES[key].title,
      sub: count(key) > 1 ? `${count(key)} PDUs` : '',
      x: CONSOLES[key].x,
      y: CONSOLES[key].titleY
    })),
    sideBox: { y: 150, h: sideBottom - 150 },
    centerBottom,
    psu,
    groups,
    wires
  }
}

function railAlert(r: PduReadings): boolean {
  return !!(r.rail12V?.flags || r.rail5V?.flags)
}

// ── Attention ───────────────────────────────────────────────────────────────

/** "1 node affected" / "3 nodes affected" — a PDU outage, wherever it is shown. */
export function affected(n: number): string {
  return `${n} node${n === 1 ? '' : 's'} affected`
}

export interface AttentionItem {
  key: string
  nodeId: number
  name: string
  state: NodeState
  flag: string
  /** A PDU outage: one item for the PDU and every node that dropped with it. */
  outage?: PduOutage
}

/**
 * Most severe first: PDU outages, then offline (incl. bus-off), then warnings — each by NODE_ID.
 * Nodes that dropped with their PDU are folded into its outage item. New nodes have their own
 * prompt; a PDU without readings is not an issue (its panel explains).
 */
export function attentionItems(views: NodeView[], outages: PduOutage[]): AttentionItem[] {
  const folded = new Set(outages.flatMap((o) => o.nodeIds))
  const items: (AttentionItem & { rank: number })[] = []
  for (const v of views) {
    const { state, flag } = v.health
    if (state !== 'off' && state !== 'warn') continue
    const outage = outages.find((o) => o.pduId === v.entry.nodeId)
    if (!outage && folded.has(v.entry.nodeId)) continue
    items.push({
      key: `n-${v.entry.nodeId}`,
      nodeId: v.entry.nodeId,
      name: v.entry.name,
      state,
      flag: outage ? `OFFLINE · ${affected(outage.nodeIds.length)}` : (flag ?? ''),
      outage,
      rank: outage ? 0 : state === 'off' ? 1 : 2
    })
  }
  return items
    .sort((a, b) => a.rank - b.rank || a.nodeId - b.nodeId)
    .map(({ rank: _rank, ...i }) => i)
}

/** How many Attention items show before "+N more". */
export const ATTENTION_SHOWN = 3

// ── health band ─────────────────────────────────────────────────────────────

export interface HealthBand {
  online: number
  /** Known nodes (registry + adopted, PDUs included); new nodes are not counted. */
  total: number
  warn: number
  off: number
  /** No complete roster yet and not reported: no data, so neither online nor offline. */
  unknown: number
  /** Summed over PDUs with fresh readings. null = no PDU has any. */
  amps12: number | null
  amps5: number | null
  watts12: number | null
  watts: number | null
  /** PDUs on the plan that have no fresh readings (offline or none). */
  pdusWithout: number
  pdusWith: number
  /** Lowest 5 V rail average and the PDU it is on. */
  low5?: { volts: number; nodeId: number; name: string }
  /** Highest TEC / REC among online nodes. */
  worstCan?: { tec: number; rec: number; nodeId: number; name: string }
  busOff: number
  hottest?: { tempC: number; nodeId: number; name: string; level: 'ok' | 'warn' | 'crit' }
}

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

export function healthBand(views: NodeView[]): HealthBand {
  const known = views.filter((v) => v.entry.source !== 'new')
  const pdus = known.filter((v) => v.entry.kind === 'pdu')
  const b: HealthBand = {
    online: known.filter((v) => v.health.state === 'on' || v.health.state === 'warn').length,
    total: known.length,
    warn: known.filter((v) => v.health.state === 'warn').length,
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
    if (st.boff) b.busOff++
    const worst = b.worstCan ? Math.max(b.worstCan.tec, b.worstCan.rec) : -1
    if (Math.max(st.tec, st.rec) > worst) {
      b.worstCan = { tec: st.tec, rec: st.rec, nodeId: v.entry.nodeId, name: v.entry.name }
    }
  }
  return b
}

// ── PSU headroom ────────────────────────────────────────────────────────────

/** A band value drawn against a PSU limit (Settings › Cockpit › Power supply). Display only. */
export interface Headroom {
  limit: number
  /** Share of the limit in use, not capped (112 = over). null = no reading. */
  pct: number | null
  /** Bar fill, 0–100. */
  bar: number
}

/** null = the limit is unknown: the card shows its plain total. */
export function headroom(value: number | null, limit: number | undefined): Headroom | null {
  if (limit === undefined) return null
  const pct = value === null ? null : (value / limit) * 100
  return { limit, pct, bar: pct === null ? 0 : Math.min(100, Math.max(0, pct)) }
}

/** `4.6%` under 10 %, `53%` from there. */
export function fmtPct(pct: number): string {
  const one = Number(pct.toFixed(1))
  return one < 10 ? `${one.toFixed(1)}%` : `${Math.round(pct)}%`
}

/** What the plan's PSU box is called: the preset's model, or plain `PSU` for a custom supply. */
export function psuName(psu: PsuSetting): string {
  return psu.mode === 'preset' ? PSU_PRESETS[psu.preset].label : 'PSU'
}

/**
 * "New on the bus · N": new NODE_IDs on the bus that have identified as a PDU or a panel group.
 * One still identifying is not news yet (isReportableNew — the Overview and event log agree).
 */
export function newCount(model: NodeModel): number {
  return model.nodes.filter(isReportableNew).length
}
