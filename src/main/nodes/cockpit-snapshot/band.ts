// The health band (moved from the renderer, R3.2): node counts, the rails' amps and
// watts, the lowest 5 V rail, the hottest PDU, the worst CAN counters and the session's peak W.
import type { CockpitBand, HealthBand, NodeView, PduRailPage } from '@shared/nodes'
import { PDU_STATUS_FLAGS as PDU_FLAG } from '@shared/firmware'
import { displayCurrentMa } from '../node-telem'

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

/**
 * The CAN errors card's sub-line. A bus-off board is the worst, whatever its counters say (a
 * bus-off node can read TEC 0), so it is named first. Otherwise a board is named only when its
 * counters are above 0; "no errors" only when nothing is bus-off and every count is 0.
 */
export function canErrorsSub(b: HealthBand): string {
  const bus = `${b.busOff} bus-off`
  if (b.busOffBoard) return `worst #${b.busOffBoard.nodeId} · ${bus}`
  const c = b.worstCan
  if (!c) return bus
  return Math.max(c.tec, c.rec) > 0 ? `worst #${c.nodeId} · ${bus}` : `no errors · ${bus}`
}

/** Who the CAN card's "worst" is, for its tooltip; undefined when it names no board. */
export function canErrorsWorst(b: HealthBand): string | undefined {
  if (b.busOffBoard) return b.busOffBoard.name
  const c = b.worstCan
  return c && Math.max(c.tec, c.rec) > 0 ? c.name : undefined
}

/**
 * The Cockpit's band (X3 co-located: the Cockpit counts its strays — online, warning — the
 * Overview's tile does not), the CAN card's value (REC only when above TEC) and the peak W.
 */
export function cockpitBand(views: NodeView[], strays: number, peakW: number): CockpitBand {
  const band = healthBand(views, strays)
  const can = band.worstCan
  const out: CockpitBand = { band, canSub: canErrorsSub(band), peakW }
  if (can) {
    out.canValue =
      can.rec > can.tec ? { counter: 'REC', value: can.rec } : { counter: 'TEC', value: can.tec }
  }
  const worst = canErrorsWorst(band)
  if (worst !== undefined) out.canWorst = worst
  return out
}
