// The Adopt dialog's facts (moved from the renderer, R3.2; since #93 the
// onboarding for every board not in your cockpit): the queue and its order, what each new NODE_ID
// is seen doing, whether it can be adopted, the registry pre-fill and the PDU it would be added
// under. The form itself (what you type) and the dialog's own memory stay in the renderer.
import {
  consoleLabel,
  type AdoptBadge,
  type AdoptForm,
  type AdoptRow,
  type Evidence,
  type NodeKind,
  type NodeModelEntry,
  type NodeView
} from '@shared/nodes'
import { amps, fmtUptime, volts } from '@shared/format'
import { nodeFlagWords } from '../faults'
import { isAdoptableKind, reportedIdentity } from '../node-kind'
import { displayCurrentMa } from '../node-telem'
import { resolveZone } from '../power-zone'
import type { Members } from './members'

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

export interface Adoptability {
  /** Set only when it can be adopted: what it identified as. */
  kind?: NodeKind
  badge: AdoptBadge
  /** Why it can't be adopted (yet), shown in place of the form. */
  note?: string
}

/**
 * Whether a new node can be adopted, by what it has identified as (entry.identified, the shared
 * resolver) and the one adopt gate's whitelist (node-kind.ts isAdoptableKind, under
 * requireAdoptable): a PDU or a panel group can; still identifying, a bridge, or a kind this client
 * doesn't know can't (it shows in Attention while it's on the bus, #93).
 */
export function adoptability(e: NodeModelEntry): Adoptability {
  const k = e.identified
  if (isAdoptableKind(k)) return { kind: k, badge: k === 'pdu' ? 'PDU' : 'PANEL GROUP' }
  switch (k) {
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
      return `Unknown board type (${e.status?.nodeKind ?? '?'}), reported by the board`
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
  if (e.availability !== 'online') {
    return { detected, reporting: 'not reporting right now', registry }
  }
  const { rail12V, rail5V } = v.readings
  if (e.kind === 'pdu' && (rail12V || rail5V)) {
    const rails = [rail('12 V', rail12V), rail('5 V', rail5V)].filter(Boolean).join(', ')
    return { detected, reporting: `telemetry: ${rails}`, registry }
  }
  if (!st) {
    // Online by its PDU pages alone (S10): its board-status page is what it sends.
    const reporting = e.kind === 'pdu' ? 'telemetry: board status' : 'not reporting right now'
    return { detected, reporting, registry }
  }
  const faults = nodeFlagWords(st)
  return {
    detected,
    reporting: `status only · up ${fmtUptime(st.uptimeSec)} · ${faults.length ? faults.join(', ') : 'healthy'}`,
    registry
  }
}

/**
 * Where the form starts (#93): a registry board pre-filled from NODE_IDS.md — name, console and its
 * default PDU — so adding it is one click; a NODE_ID the registry does not know starts blank. The
 * default PDU only if it is in your cockpit, hidden ones included (D7: its resolved zone is not
 * `none`); otherwise None — a zone is never a PDU you have not added.
 */
export function prefill(e: NodeModelEntry, kind: NodeKind, members: Members): AdoptForm {
  const r = e.registry
  if (!r) return { name: '', console: '', pduId: '' }
  if (kind === 'pdu') return { name: r.name, console: r.console, pduId: null }
  const zone = resolveZone(members.get, r.pduId)
  return { name: r.name, console: r.console, pduId: zone.status === 'none' ? null : zone.pduId }
}

/**
 * "Add all N panel groups from NODE_IDS.md" (#93): an untouched registry panel group is added with
 * its pre-fill — its default PDU only if that PDU is in your cockpit, else None (D7). undefined =
 * not one Add all takes (a PDU, or not in NODE_IDS.md).
 */
function addAllPduId(row: NodeView, members: Members): number | null | undefined {
  if (!row.entry.registry || adoptability(row.entry).kind !== 'panel') return undefined
  const { pduId } = prefill(row.entry, 'panel', members)
  return pduId === '' ? null : pduId
}

/** The dialog's queue, each row with what the dialog shows for it. */
export function adoptRows(views: NodeView[], members: Members): AdoptRow[] {
  return adoptQueue(views).map((view) => {
    const e = view.entry
    const able = adoptability(e)
    const row: AdoptRow = {
      view,
      badge: able.badge,
      evidence: adoptEvidence(view),
      // keptQueue's offline copy of a row that left the model, as the dialog shows it.
      goneEvidence: adoptEvidence({ ...view, entry: { ...e, availability: 'offline' } }),
      // Only a node identified as a PDU or a panel group gets the form; anything else is shown as-is.
      prefill: able.kind
        ? prefill(e, able.kind, members)
        : prefill({ ...e, registry: undefined }, 'panel', members)
    }
    if (able.kind) row.kind = able.kind
    if (able.note !== undefined) row.note = able.note
    const bulk = addAllPduId(view, members)
    if (bulk !== undefined) row.addAllPduId = bulk
    return row
  })
}
