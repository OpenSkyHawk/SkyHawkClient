// Cockpit Adopt dialog (#77): the pure decisions behind it — queue order, what each new NODE_ID
// is seen doing, when the form is complete, the identify row and where the selection goes next.
import type { AdoptSpec, NodeKind } from '@shared/node-mapping'
import { reportedIdentity } from '@shared/node-kind'
import type { NodeModelEntry } from '@shared/node-rules'
import { displayCurrentMa } from '@shared/node-telem'
import { nodeFaultTag } from '@shared/nodes'
import type { NodeView } from './cockpit'
import { fmtUptime } from './store'

/**
 * New NODE_IDs, oldest first seen first, then by NODE_ID. Not-yet-seen times sort last. Every new
 * node is listed — still identifying, or a kind that can't be adopted — so you can see what each
 * one is; only a PDU or a panel group can be adopted (adoptability()).
 */
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

export interface Adoptability {
  /** Set only when it can be adopted: what it identified as. */
  kind?: NodeKind
  badge: 'PDU' | 'PANEL GROUP' | 'IDENTIFYING' | 'BRIDGE' | 'UNKNOWN TYPE'
  /** Why it can't be adopted (yet), shown in place of the form. */
  note?: string
}

/**
 * Whether a new node can be adopted, by what it has identified as (entry.identified, the shared
 * resolver). A whitelist: a PDU or a panel group can; still identifying, a bridge, or a kind this
 * client doesn't know can't (it shows in Attention while it's on the bus, #93).
 */
export function adoptability(e: NodeModelEntry): Adoptability {
  switch (e.identified) {
    case 'pdu':
      return { kind: 'pdu', badge: 'PDU' }
    case 'panel':
      return { kind: 'panel', badge: 'PANEL GROUP' }
    case 'bridge':
      return {
        badge: 'BRIDGE',
        note: 'It reports as a SimGateway / PanelBridge. A cockpit has one, on NODE_ID 0, so this one can’t be adopted. It stays in Attention as an issue while it’s on the bus.'
      }
    case 'other':
      return {
        badge: 'UNKNOWN TYPE',
        note: `It reports a board type this client doesn’t know (${e.status?.nodeKind ?? '?'}), so it can’t be adopted. A newer client may know it. It stays in Attention as an issue while it’s on the bus.`
      }
    default:
      return {
        badge: 'IDENTIFYING',
        note: 'Identifying… waiting for the board to report its type. If it doesn’t within a few seconds, it shows in Attention as an issue.'
      }
  }
}

export interface Evidence {
  /** What it identified as, and from which signal; or that it hasn't yet. */
  detected: string
  reporting: string
  registry: string
}

/** "Detected as": the kind and the signal it came from. */
function detectedAs(e: NodeModelEntry): string {
  const said = reportedIdentity(e.status?.nodeKind)
  const how = said ? 'reported by the board' : 'PDU telemetry seen'
  switch (e.identified) {
    case 'pdu':
      return `PDU (${how})`
    case 'panel':
      return 'panel group (reported by the board)'
    case 'bridge':
      return 'SimGateway / PanelBridge (reported by the board)'
    case 'other':
      return `unknown board type ${e.status?.nodeKind ?? ''} (reported by the board)`.trim()
    default:
      return 'not known yet'
  }
}

const rail = (label: string, p?: { vAvgMv: number; iAvgMa: number }) =>
  p
    ? `${label} ${(p.vAvgMv / 1000).toFixed(2)} V · ${(displayCurrentMa(p.iAvgMa) / 1000).toFixed(2)} A`
    : ''

/** What the dialog can say about a new NODE_ID: only what it has reported. */
export function adoptEvidence(v: NodeView): Evidence {
  const e = v.entry
  const st = e.status
  const detected = detectedAs(e)
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
 * After Adopt the current one leaves the queue: take the one after it, else the first
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

/**
 * A normal board reports its kind ~1 s after it appears. Until this has passed, an unidentified
 * new board is simply still identifying — not an issue — so it never flashes a warning.
 */
export const IDENTIFY_WAIT_MS = 5000

/**
 * New boards on the bus that can't be adopted (#93): a kind that can't be adopted (a second
 * SimGateway, a type this client doesn't know), or still unidentified after IDENTIFY_WAIT_MS. A
 * board on the bus is active, so it can't be hidden — it shows in Attention as a warning instead.
 * `nextAt` = when one still identifying will cross the line.
 */
export function strayNew(views: NodeView[], now: number): { strays: NodeView[]; nextAt?: number } {
  const strays: NodeView[] = []
  let nextAt: number | undefined
  for (const v of views) {
    const e = v.entry
    if (e.source !== 'new' || e.availability !== 'online' || adoptability(e).kind) continue
    const due = (e.firstSeenAt ?? 0) + IDENTIFY_WAIT_MS
    if (e.identified || due <= now) strays.push(v)
    else nextAt = Math.min(nextAt ?? due, due)
  }
  return nextAt === undefined ? { strays } : { strays, nextAt }
}

/** A stray's Attention line: what it is, and that it can't be adopted. */
export function strayFlag(e: NodeModelEntry): string {
  const what =
    e.identified === 'bridge'
      ? 'SECOND SIMGATEWAY'
      : e.identified
        ? 'UNKNOWN BOARD TYPE'
        : 'UNIDENTIFIED'
  return `${what} · can’t be adopted`
}
