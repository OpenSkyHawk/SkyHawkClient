// The Adopt dialog's own state (R3.2): the unsaved form and what it would send, the rows the dialog
// keeps while it is open, the identify dot and where the selection goes next. What each row is and
// what it starts as are main's (cockpit:snapshot adopt); "Add all" still sequences here (R3.2b).
import type { AdoptForm, AdoptRow, AdoptSpec, NodeKind, ZoneChoices } from '@shared/nodes'
import { zoneOptions } from './panel-view'

/**
 * The queue while the dialog is open (#93 re-review): what is waiting now, plus every row it has
 * already shown that is gone from the model — kept, offline, so power-cycling a board to identify
 * it (a registry board not added leaves the model when it drops) doesn't close the dialog or lose
 * its form. A row leaves only once added (`done`) or when the dialog closes. Rows keep main's
 * queue order (oldest first seen first, then by NODE_ID).
 */
export function keptQueue(
  live: AdoptRow[],
  shown: ReadonlyMap<number, AdoptRow>,
  done: ReadonlySet<number>
): AdoptRow[] {
  const ids = new Set(live.map((r) => r.view.entry.nodeId))
  const gone = [...shown.values()]
    .filter((r) => !ids.has(r.view.entry.nodeId) && !done.has(r.view.entry.nodeId))
    .map(
      (r): AdoptRow => ({
        ...r,
        view: { ...r.view, entry: { ...r.view.entry, availability: 'offline' } },
        evidence: r.goneEvidence
      })
    )
  const at = (r: AdoptRow) => r.view.entry.firstSeenAt ?? Number.POSITIVE_INFINITY
  return [...live.filter((r) => !done.has(r.view.entry.nodeId)), ...gone].sort(
    (a, b) => at(a) - at(b) || a.view.entry.nodeId - b.view.entry.nodeId
  )
}

/**
 * The Adopt form's Powered by list (#93), as main pushed it for the form's console and choice; and
 * — only when the chosen PDU is not in your cockpit at all — that PDU as `pending`, which the form
 * marks "(not added)".
 */
export function adoptPduChoices(
  zones: ZoneChoices,
  row: AdoptRow,
  console: string,
  pduId: number | null | ''
): { zones: { value: number; label: string }[]; pending?: string } {
  const chosen = typeof pduId === 'number' ? pduId : null
  const options = zoneOptions(zones, console, chosen)
  if (chosen === null || options.some((z) => z.value === chosen)) return { zones: options }
  return {
    zones: options,
    pending: row.pending?.pduId === chosen ? row.pending.name : `PDU #${chosen}`
  }
}

/**
 * "Add all N panel groups from NODE_IDS.md" (#93): the waiting registry panel groups. PDUs are added
 * one by one. A board whose form you changed is added as its form says (None included — that is a
 * choice); an untouched one with its defaults and the PDU main says it keeps (`addAllPduId`). An
 * unfinished form skips it.
 */
export function registrySpecs(
  queue: AdoptRow[],
  edits: ReadonlyMap<number, AdoptForm> = new Map()
): { nodeId: number; spec: AdoptSpec }[] {
  const out: { nodeId: number; spec: AdoptSpec }[] = []
  for (const r of queue) {
    if (r.addAllPduId === undefined) continue
    const edited = edits.get(r.view.entry.nodeId)
    const spec = adoptSpec('panel', edited ?? { ...r.prefill, pduId: r.addAllPduId })
    if (spec) out.push({ nodeId: r.view.entry.nodeId, spec })
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
