// Cockpit Adopt dialog (#77): the pure decisions behind it — queue order, what each new NODE_ID
// is seen doing, when the form is complete, the identify row and where the selection goes next.
import type { AdoptSpec, NodeKind } from '@shared/node-mapping'
import { displayCurrentMa } from '@shared/node-telem'
import { nodeFaultTag } from '@shared/nodes'
import type { NodeView } from './cockpit'
import { fmtUptime } from './store'

/** New NODE_IDs, oldest first seen first, then by NODE_ID. Not-yet-seen times sort last. */
export function adoptQueue(views: NodeView[]): NodeView[] {
  const at = (v: NodeView) => v.entry.firstSeenAt ?? Number.POSITIVE_INFINITY
  return views
    .filter((v) => v.entry.source === 'new')
    .sort((a, b) => at(a) - at(b) || a.entry.nodeId - b.entry.nodeId)
}

/** "first seen 2 min ago" — this session's first sighting (it is not persisted). */
export function seenAgo(firstSeenAt: number | undefined, now: number): string {
  if (firstSeenAt === undefined) return 'first seen this session'
  const s = Math.max(0, Math.round((now - firstSeenAt) / 1000))
  if (s < 60) return 'first seen just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `first seen ${m} min ago`
  return `first seen ${Math.floor(m / 60)} h ago`
}

export interface Evidence {
  /** 'PDU' when it has sent PDU telemetry pages, else 'panel group'. */
  detected: 'PDU' | 'panel group'
  reporting: string
  registry: string
}

const rail = (label: string, p?: { vAvgMv: number; iAvgMa: number }) =>
  p
    ? `${label} ${(p.vAvgMv / 1000).toFixed(2)} V · ${(displayCurrentMa(p.iAvgMa) / 1000).toFixed(2)} A`
    : ''

/** What the dialog can say about a new NODE_ID: only what it has reported. */
export function adoptEvidence(v: NodeView): Evidence {
  const e = v.entry
  const st = e.status
  const detected = e.kind === 'pdu' ? 'PDU' : 'panel group'
  const registry = 'not in NODE_IDS.md'
  if (e.availability !== 'online' || !st) {
    return { detected, reporting: 'not reporting right now', registry }
  }
  const { rail12V, rail5V } = v.readings
  if (e.kind === 'pdu' && (rail12V || rail5V)) {
    const rails = [rail('12 V', rail12V), rail('5 V', rail5V)].filter(Boolean).join(', ')
    return { detected, reporting: `telemetry: ${rails}`, registry }
  }
  const faults = [
    st.boff && 'bus-off',
    st.degraded && nodeFaultTag(st),
    st.overheat && 'overheat',
    st.epvf && 'error-passive'
  ].filter((f): f is string => !!f)
  return {
    detected,
    reporting: `status only · up ${fmtUptime(st.uptimeSec)} · ${faults.length ? faults.join(', ') : 'healthy'}`,
    registry
  }
}

export interface AdoptForm {
  name: string
  console: string
  /** Panels only. '' = not chosen yet; null = None (no PDU feeds it). */
  pduId: number | null | ''
}

/** The adopt request, or null while the form is incomplete. A PDU has no powered-by. */
export function adoptSpec(kind: NodeKind, f: AdoptForm): AdoptSpec | null {
  const name = f.name.trim()
  if (!name || !f.console) return null
  if (kind === 'pdu') return { name, console: f.console, pduId: null, kind }
  if (f.pduId === '') return null
  return { name, console: f.console, pduId: f.pduId, kind }
}

/**
 * The identify row's dot while the user power-cycles a board: blue while it reports, red once it
 * has dropped off the bus, green when it comes back after a drop.
 */
export function identState(online: boolean, droppedSinceOpen: boolean): 'new' | 'off' | 'on' {
  if (!online) return 'off'
  return droppedSinceOpen ? 'on' : 'new'
}

/**
 * Which NODE_ID to select next. `order` is the queue as it was shown; `queue` is what is left.
 * After Adopt or Ignore the current one leaves the queue: take the one after it, else the first
 * left. Later keeps the current one queued and moves on; past the end there is nothing (close).
 */
export function nextSelection(
  order: number[],
  queue: number[],
  current: number,
  how: 'done' | 'later'
): number | null {
  const left = new Set(queue)
  const after = order.slice(order.indexOf(current) + 1).find((id) => left.has(id))
  if (how === 'later') return after ?? null
  return after ?? queue.find((id) => id !== current) ?? null
}
