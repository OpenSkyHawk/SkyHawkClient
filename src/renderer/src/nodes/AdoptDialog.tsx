import { useEffect, useMemo, useRef, useState } from 'react'
import { seenAgo } from '@shared/format'
import {
  CONSOLE_OPTIONS,
  type AdoptBadge,
  type AdoptForm as FormValues,
  type AdoptRow,
  type NodeMappingResult,
  type ZoneChoices
} from '@shared/nodes'
import { adoptSpec, identState, keptQueue, nextSelection, registrySpecs } from './adopt-view'
import { zoneOptions } from './panel-view'
import { useModalFocus } from '../app/kit'
import { useNodesStore } from './store'
import { Dot } from './Dot'

/**
 * New on the bus (#77): name and place each NODE_ID the registry does not know, or leave it for
 * later. A board that can't be adopted is listed so you can see what it is; it stays in Attention
 * while it's on the bus (#93 — no Ignore). Esc, the scrim and Close shut it; focus returns to
 * what opened it. `initial` selects a NODE_ID (a stray's Attention cog).
 */
export function AdoptDialog(props: {
  /** Main's queue: new NODE_IDs, oldest first seen first. */
  rows: AdoptRow[]
  zones: ZoneChoices
  initial?: number
  onClose: () => void
}) {
  const ref = useRef<HTMLElement>(null)
  useModalFocus(ref, props.onClose)

  const live = props.rows
  // Rows this dialog has shown, so one that drops (power-cycled to identify it) stays listed.
  const shown = useRef(new Map<number, AdoptRow>())
  for (const r of live) shown.current.set(r.view.entry.nodeId, r)
  const [done, setDone] = useState<ReadonlySet<number>>(new Set())
  const queue = useMemo(() => keptQueue(live, shown.current, done), [live, done])
  const ids = queue.map((r) => r.view.entry.nodeId)
  // The queue as the dialog showed it, so "next" keeps its place as nodes leave it.
  const order = useRef<number[]>(ids)
  for (const id of ids) if (!order.current.includes(id)) order.current.push(id)
  const [sel, setSel] = useState<number | null>(
    props.initial !== undefined && ids.includes(props.initial) ? props.initial : (ids[0] ?? null)
  )
  const current = queue.find((r) => r.view.entry.nodeId === sel) ?? queue[0]

  // NODE_IDs that dropped off the bus while the dialog was open (power-cycle to identify).
  const [dropped, setDropped] = useState<ReadonlySet<number>>(new Set())
  useEffect(() => {
    const off = queue
      .filter((r) => r.view.entry.availability !== 'online')
      .map((r) => r.view.entry.nodeId)
    if (off.some((id) => !dropped.has(id))) setDropped(new Set([...dropped, ...off]))
  }, [queue, dropped])

  // Nothing left to adopt (all adopted or gone): close.
  const { onClose } = props
  useEffect(() => {
    if (queue.length === 0) onClose()
  }, [queue.length, onClose])

  // "Add all N panel groups from NODE_IDS.md": PDUs one by one, links only to PDUs in your cockpit.
  // Each board's form, as you left it, while the dialog is open: switching rows keeps it, and
  // "Add all" takes it (None included) over the NODE_IDS.md defaults.
  const [edits, setEdits] = useState<ReadonlyMap<number, FormValues>>(new Map())
  const bulk = registrySpecs(queue, edits)
  const [bulkError, setBulkError] = useState('')
  // Main adopts them one at a time and stops at the first it refuses (R3.2b); the ones it added
  // leave the queue.
  const addAll = async () => {
    setBulkError('')
    const r = await useNodesStore.getState().addAllNodes(bulk)
    setDone(new Set([...done, ...(r ? r.done : bulk.map((b) => b.nodeId))]))
    if (r && !r.ok) setBulkError(`NODE_ID ${r.nodeId}: ${r.error}`)
  }

  if (!current) return null
  const move = (how: 'done' | 'later') => {
    if (how === 'done') setDone(new Set([...done, current.view.entry.nodeId]))
    const next = nextSelection(order.current, ids, current.view.entry.nodeId, how)
    if (next === null && how === 'later') return props.onClose()
    setSel(next)
  }

  return (
    <>
      <div className="ad__scrim" onClick={props.onClose} />
      <section
        ref={ref}
        className="ad"
        role="dialog"
        aria-modal="true"
        aria-label="Adopt new devices"
        tabIndex={-1}
      >
        <div className="ad__h">
          <span className="node__dot new sym" aria-hidden="true">
            +
          </span>
          <div>
            <div className="ad__t">New on the bus</div>
            <div className="ad__s">
              {queue.length} board{queue.length === 1 ? '' : 's'} this computer hasn’t added yet.
              Boards in NODE_IDS.md come pre-filled — check them and add.
            </div>
          </div>
          <button className="toolbtn" style={{ marginLeft: 'auto' }} onClick={props.onClose}>
            Close
          </button>
        </div>
        <div className="ad__b">
          <div className="ad__q" role="listbox" aria-label="New NODE_IDs">
            {queue.map((r) => {
              const v = r.view
              const on = v.entry.nodeId === current.view.entry.nodeId
              return (
                <button
                  key={v.entry.nodeId}
                  role="option"
                  aria-selected={on}
                  className={`ad__i${on ? ' on' : ''}`}
                  onClick={() => setSel(v.entry.nodeId)}
                >
                  <div className="ad__in">
                    <span className="node__dot new" aria-hidden="true" />
                    NODE_ID {v.entry.nodeId}
                    <Badge badge={r.badge} />
                  </div>
                  <div className="ad__im">
                    {v.entry.registry
                      ? `${v.entry.registry.name} · in NODE_IDS.md`
                      : seenAgo(v.entry.firstSeenAt, Date.now())}
                  </div>
                </button>
              )
            })}
          </div>
          <AdoptForm
            key={current.view.entry.nodeId}
            row={current}
            zones={props.zones}
            dropped={dropped.has(current.view.entry.nodeId)}
            position={`${ids.indexOf(current.view.entry.nodeId) + 1} of ${ids.length}`}
            form={edits.get(current.view.entry.nodeId)}
            onForm={(f) => setEdits(new Map(edits).set(current.view.entry.nodeId, f))}
            bulk={bulk.length > 1 ? bulk.length : 0}
            bulkError={bulkError}
            onAddAll={() => void addAll()}
            onDone={() => move('done')}
            onLater={() => move('later')}
          />
        </div>
      </section>
    </>
  )
}

function AdoptForm(props: {
  /** Main's row: what it is, what it starts as, what it is seen doing. */
  row: AdoptRow
  zones: ZoneChoices
  dropped: boolean
  position: string
  /** Registry panel groups waiting (2 or more): offer "Add all N panel groups from NODE_IDS.md". */
  bulk: number
  /** This board's form as you left it; undefined = not touched yet (pre-fill / blank). */
  form?: FormValues
  onForm: (f: FormValues) => void
  bulkError: string
  onAddAll: () => void
  onDone: () => void
  onLater: () => void
}) {
  const { row } = props
  const e = row.view.entry
  const id = e.nodeId
  // Only a node identified as a PDU or a panel group gets the form; anything else is shown as-is.
  const kind = row.kind
  const form = props.form ?? row.prefill
  const { name, console: con, pduId } = form
  const setName = (v: string) => props.onForm({ ...form, name: v })
  const setPduId = (v: number | null | '') => props.onForm({ ...form, pduId: v })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ev = row.evidence
  // #93: the PDU is explicit, and only ever one in your cockpit (D7): one on another console is
  // "(other console)", a hidden one "(hidden)". Changing the console clears it (N9).
  const zones = zoneOptions(props.zones, con, typeof pduId === 'number' ? pduId : null)
  const spec = kind ? adoptSpec(kind, { name, console: con, pduId }) : null
  const ident = identState(e.availability === 'online', props.dropped)

  const run = async (call: () => Promise<NodeMappingResult> | undefined) => {
    setBusy(true)
    setError('')
    const r = await call()
    setBusy(false)
    if (!r) return setError('Not connected to the client process.')
    if (r.ok) props.onDone()
    else setError(r.error)
  }

  // Fields and footer are siblings in the dialog's grid, so the footer spans both columns.
  return (
    <>
      <div className="ad__f">
        <div className="ad__ev">
          <div>
            <span className="ad__k">Detected as</span>
            <b>{ev.detected}</b>
          </div>
          <div>
            <span className="ad__k">Reporting</span>
            <b>{ev.reporting}</b>
          </div>
          <div>
            <span className="ad__k">Registry</span>
            <b>{ev.registry}</b>
          </div>
        </div>
        {!kind ? (
          <div className="ad__wait" role="status">
            {row.note}
          </div>
        ) : (
          <>
            {e.registry && (
              <div className="hint ad__pre">
                Pre-filled from NODE_IDS.md. Change anything before adding — it’s saved on this
                computer.
              </div>
            )}
            <label className="input-label" htmlFor="ad-name">
              Name
            </label>
            <input
              id="ad-name"
              className="input"
              placeholder={kind === 'pdu' ? 'e.g. PDU_Right_Aft' : 'e.g. Right_Oxygen'}
              value={name}
              onChange={(ev) => setName(ev.target.value)}
            />
            <div className="ad__row">
              <div>
                <label className="input-label" htmlFor="ad-console">
                  Console
                </label>
                <select
                  id="ad-console"
                  className="input"
                  value={con}
                  onChange={(ev) => props.onForm({ ...form, console: ev.target.value, pduId: '' })}
                >
                  <option value="">Choose…</option>
                  {CONSOLE_OPTIONS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              {kind === 'panel' && (
                <div>
                  <label className="input-label" htmlFor="ad-pdu">
                    Powered by
                  </label>
                  <select
                    id="ad-pdu"
                    className="input"
                    value={pduId === null ? 'none' : pduId}
                    disabled={!con}
                    onChange={(ev) =>
                      setPduId(
                        ev.target.value === ''
                          ? ''
                          : ev.target.value === 'none'
                            ? null
                            : Number(ev.target.value)
                      )
                    }
                  >
                    <option value="">Choose…</option>
                    <option value="none">None</option>
                    {zones.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </>
        )}
        <div className="ident" role="status">
          <Dot state={ident} />
          <span>
            <b>Not sure which board this is?</b> Power-cycle it — this row turns red when #{id}{' '}
            drops off the bus and green when it’s back.
          </span>
        </div>
        {kind && !e.registry && (
          <div className="hint">
            Saved on this computer. To make it permanent for everyone, add NODE_ID {id} to
            NODE_IDS.md.
          </div>
        )}
        {(error || props.bulkError) && (
          <div className="set-err ad__err">{error || props.bulkError}</div>
        )}
      </div>
      <div className="ad__ft">
        <span className="hint ad__pos">{props.position}</span>
        {props.bulk > 0 && (
          <button className="toolbtn" disabled={busy} onClick={props.onAddAll}>
            Add all {props.bulk} panel groups from NODE_IDS.md
          </button>
        )}
        <button
          className="toolbtn"
          style={{ marginLeft: 'auto' }}
          disabled={busy}
          onClick={props.onLater}
        >
          Later
        </button>
        <button
          className="browse"
          disabled={busy || !spec}
          onClick={() => spec && void run(() => useNodesStore.getState().adoptNode(id, spec))}
        >
          {e.registry ? 'Add to cockpit' : 'Adopt'}
        </button>
      </div>
    </>
  )
}

const BADGE_CLASS: Record<AdoptBadge, string> = {
  PDU: 'kind--pdu',
  'PANEL GROUP': 'kind--pg',
  IDENTIFYING: 'kind--wait',
  BRIDGE: 'kind--no',
  'UNKNOWN TYPE': 'kind--no'
}

function Badge({ badge }: { badge: AdoptBadge }) {
  return <span className={`kind ${BADGE_CLASS[badge]}`}>{badge}</span>
}
