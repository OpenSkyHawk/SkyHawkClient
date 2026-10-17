// The plan's grouping (moved from the renderer's planLayout, R3.2): which boards are
// drawn, the power zone each sits in and on which console, the outage under a PDU, and which feed
// lines go gold. The renderer lays these groups out (plan-layout.ts); it decides none of them.
import type {
  ConsoleKey,
  NodeView,
  PduOutage,
  PduReadings,
  PlanConsole,
  PlanGroupHead,
  PlanZone,
  PowerZone
} from '@shared/nodes'

/** NODE_IDS.md consoles are `Left` / `Center` / `Right`; anything else lands on the panel. */
export function consoleKey(console: string | null): ConsoleKey {
  const c = (console ?? '').toLowerCase()
  if (c.startsWith('left')) return 'L'
  if (c.startsWith('right')) return 'R'
  return 'C'
}

function railAlert(r: PduReadings): boolean {
  return !!(r.rail12V?.flags || r.rail5V?.flags)
}

/**
 * A PDU group's header: OFFLINE overrides its flags; a rail value shows only while the PDU is up
 * with readings, gold while the PDU flags that rail.
 */
function groupHead(p: NodeView): PlanGroupHead {
  const off = p.health.state === 'off'
  const dash = off || p.noReadings
  const r12 = p.readings.rail12V
  const r5 = p.readings.rail5V
  const head: PlanGroupHead = {
    off,
    flags: off ? ['OFFLINE'] : p.health.state === 'warn' ? (p.health.flag ?? '').split(' · ') : [],
    noReadings: p.noReadings && !off
  }
  if (!dash && r12) head.rail12V = { mv: r12.vAvgMv, alert: !!r12.flags }
  if (!dash && r5) head.rail5V = { mv: r5.vAvgMv, alert: !!r5.flags }
  return head
}

/**
 * One group per PDU on the PDU's console, then the console's nodes without a power zone. A panel
 * sits under the PDU that feeds it, wherever its own console is, while its resolved zone is
 * `active` (D7, `zones`); new nodes are not placed (they wait in "New on the bus"). A panel whose
 * zone is a hidden PDU keeps the link but sits in its own console's No power zone (B10).
 */
export function planZones(
  views: NodeView[],
  outages: PduOutage[],
  zones: ReadonlyMap<number, PowerZone>
): PlanConsole[] {
  const pdus = views.filter((v) => v.entry.kind === 'pdu' && v.entry.source !== 'new')
  const pduIds = new Set(pdus.map((p) => p.entry.nodeId))
  const panels = views.filter((v) => v.entry.kind === 'panel' && v.entry.source !== 'new')
  /** The PDU on the plan it sits under, if any. */
  const under = (v: NodeView): number | undefined => {
    const z = zones.get(v.entry.nodeId)
    return z?.status === 'active' && pduIds.has(z.pduId) ? z.pduId : undefined
  }
  return (['L', 'C', 'R'] as const).map((key) => {
    const zones: PlanZone[] = []
    const place = (pdu: NodeView | null, members: NodeView[]) => {
      const outage = pdu ? outages.find((o) => o.pduId === pdu.entry.nodeId) : undefined
      const z: PlanZone = { key: pdu ? `pdu-${pdu.entry.nodeId}` : `none-${key}`, pdu, members }
      if (pdu) z.head = groupHead(pdu)
      if (outage) z.outage = outage
      zones.push(z)
    }
    const on = pdus.filter((p) => consoleKey(p.entry.console) === key)
    for (const pdu of on) {
      place(
        pdu,
        panels.filter((p) => under(p) === pdu.entry.nodeId)
      )
    }
    const loose = panels.filter(
      (p) => consoleKey(p.entry.console) === key && under(p) === undefined
    )
    if (loose.length) place(null, loose)
    // One feed line per PDU, gold while it raises a rail flag.
    return { key, zones, feeds: on.map((p) => railAlert(p.readings)) }
  })
}
