// Cockpit Adopt dialog (#77; since #93 the onboarding for every board not in your cockpit): the
// pure decisions behind it — queue order, what each new NODE_ID is seen doing, the registry
// pre-fill, when the form is complete, the identify row and where the selection goes next.
import { amps, fmtUptime, volts } from '@shared/format'
import type { AdoptSpec, NodeKind, NodeModelEntry } from '@shared/nodes'
import { displayCurrentMa, nodeFaultTag, reportedIdentity } from '@shared/nodes/legacy-rules'
import type { NodeView } from './cockpit'
import { consoleLabel, powerZoneOptions } from './cockpit-panels'

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

/**
 * The queue while the dialog is open (#93 re-review): what is waiting now, plus every row it has
 * already shown that is gone from the model — kept, offline, so power-cycling a board to identify
 * it (a registry board not added leaves the model when it drops) doesn't close the dialog or lose
 * its form. A row leaves only once added (`done`) or when the dialog closes.
 */
export function keptQueue(
  live: NodeView[],
  shown: ReadonlyMap<number, NodeView>,
  done: ReadonlySet<number>
): NodeView[] {
  const ids = new Set(live.map((v) => v.entry.nodeId))
  const gone = [...shown.values()]
    .filter((v) => !ids.has(v.entry.nodeId) && !done.has(v.entry.nodeId))
    .map((v): NodeView => ({ ...v, entry: { ...v.entry, availability: 'offline' } }))
  return adoptQueue([...live.filter((v) => !done.has(v.entry.nodeId)), ...gone])
}

/**
 * The Adopt form's Powered by list (#93): the console's PDUs in your cockpit; the chosen one if it is
 * in your cockpit on another console, marked "(other console)"; and — only when the chosen PDU is
 * not in your cockpit at all — that PDU as `pending`, which the form marks "(not added)".
 */
export function adoptPduChoices(
  views: NodeView[],
  console: string,
  pduId: number | null | '',
  e: NodeModelEntry
): { zones: { value: number; label: string }[]; pending?: string } {
  const chosen = typeof pduId === 'number' ? pduId : null
  const zones = powerZoneOptions(views, console, chosen)
  if (chosen === null || zones.some((z) => z.value === chosen)) return { zones }
  const waiting = views.find((v) => v.entry.nodeId === chosen)
  const name =
    waiting?.entry.name ??
    ((e.registry?.pduId === chosen && e.registry.pduName) || `PDU #${chosen}`)
  return { zones, pending: name }
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
        note: 'It reports as a Gateway. A cockpit has one, on NODE_ID 0, so this one can’t be adopted. It stays in Attention as an issue while it’s on the bus.'
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
  // Not reported (yet): only PDU pages tell — never the NODE_ID or its NODE_IDS.md entry (#93).
  const how = said ? 'reported by the board' : 'PDU telemetry seen'
  switch (e.identified) {
    case 'pdu':
      return `PDU (${how})`
    case 'panel':
      return 'panel group (reported by the board)'
    case 'bridge':
      return 'Gateway (reported by the board)'
    case 'other':
      return `unknown board type ${e.status?.nodeKind ?? ''} (reported by the board)`.trim()
    default:
      return 'not known yet'
  }
}

const rail = (label: string, p?: { vAvgMv: number; iAvgMa: number }) =>
  p ? `${label} ${volts(p.vAvgMv)} · ${amps(displayCurrentMa(p.iAvgMa))}` : ''

/** What the dialog can say about a new NODE_ID: only what it has reported. */
export function adoptEvidence(v: NodeView): Evidence {
  const e = v.entry
  const st = e.status
  const detected = detectedAs(e)
  const registry = e.registry
    ? `NODE_IDS.md: ${e.registry.name}, ${consoleLabel(e.registry.console)}`
    : 'not in NODE_IDS.md'
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

/**
 * Where the form starts (#93): a registry board pre-filled from NODE_IDS.md — name, console and its
 * default PDU — so adding it is one click; a NODE_ID the registry does not know starts blank.
 */
export function prefill(e: NodeModelEntry, kind: NodeKind): AdoptForm {
  const r = e.registry
  if (!r) return { name: '', console: '', pduId: '' }
  return { name: r.name, console: r.console, pduId: kind === 'pdu' ? null : r.pduId }
}

/**
 * "Add all N panel groups from NODE_IDS.md" (#93): the waiting registry panel groups. PDUs are added
 * one by one. A board whose form you changed is added as its form says (None included — that is a
 * choice); an untouched one with its defaults, keeping its default PDU only if that PDU is already
 * in your cockpit (`views`), else None — the PDU choice stays explicit. An unfinished form skips it.
 */
export function registrySpecs(
  queue: NodeView[],
  views: NodeView[],
  edits: ReadonlyMap<number, AdoptForm> = new Map()
): { nodeId: number; spec: AdoptSpec }[] {
  const inCockpit = (id: number | null) =>
    id !== null &&
    views.some((v) => v.entry.nodeId === id && v.entry.kind === 'pdu' && v.entry.source !== 'new')
  const out: { nodeId: number; spec: AdoptSpec }[] = []
  for (const v of queue) {
    if (!v.entry.registry || adoptability(v.entry).kind !== 'panel') continue
    const edited = edits.get(v.entry.nodeId)
    const form = prefill(v.entry, 'panel')
    const pduId = typeof form.pduId === 'number' && inCockpit(form.pduId) ? form.pduId : null
    const spec = adoptSpec('panel', edited ?? { ...form, pduId })
    if (spec) out.push({ nodeId: v.entry.nodeId, spec })
  }
  return out
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
      ? 'SECOND GATEWAY'
      : e.identified
        ? 'UNKNOWN BOARD TYPE'
        : 'UNIDENTIFIED'
  return `${what} · can’t be adopted`
}
