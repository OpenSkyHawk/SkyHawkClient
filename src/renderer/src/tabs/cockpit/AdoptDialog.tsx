import { useEffect, useMemo, useRef, useState } from 'react'
import type { NodeMappingResult } from '@shared/nodes/ipc'
import type { NodeView } from '../../cockpit'
import {
  adoptability,
  adoptEvidence,
  adoptPduChoices,
  adoptQueue,
  adoptSpec,
  identState,
  keptQueue,
  nextSelection,
  prefill,
  registrySpecs,
  seenAgo,
  type AdoptForm as FormValues
} from '../../cockpit-adopt'
import { CONSOLE_OPTIONS } from '../../cockpit-panels'
import { useModalFocus } from '../../useModalFocus'
import { Dot } from './Dot'

/**
 * New on the bus (#77): name and place each NODE_ID the registry does not know, or leave it for
 * later. A board that can't be adopted is listed so you can see what it is; it stays in Attention
 * while it's on the bus (#93 — no Ignore). Esc, the scrim and Close shut it; focus returns to
 * what opened it. `initial` selects a NODE_ID (a stray's Attention cog).
 */
export function AdoptDialog(props: { views: NodeView[]; initial?: number; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null)
  useModalFocus(ref, props.onClose)

  const live = useMemo(() => adoptQueue(props.views), [props.views])
  // Rows this dialog has shown, so one that drops (power-cycled to identify it) stays listed.
  const shown = useRef(new Map<number, NodeView>())
  for (const v of live) shown.current.set(v.entry.nodeId, v)
  const [done, setDone] = useState<ReadonlySet<number>>(new Set())
  const queue = useMemo(() => keptQueue(live, shown.current, done), [live, done])
  const ids = queue.map((v) => v.entry.nodeId)
  // The queue as the dialog showed it, so "next" keeps its place as nodes leave it.
  const order = useRef<number[]>(ids)
  for (const id of ids) if (!order.current.includes(id)) order.current.push(id)
  const [sel, setSel] = useState<number | null>(
    props.initial !== undefined && ids.includes(props.initial) ? props.initial : (ids[0] ?? null)
  )
  const current = queue.find((v) => v.entry.nodeId === sel) ?? queue[0]

  // NODE_IDs that dropped off the bus while the dialog was open (power-cycle to identify).
  const [dropped, setDropped] = useState<ReadonlySet<number>>(new Set())
  useEffect(() => {
    const off = queue.filter((v) => v.entry.availability !== 'online').map((v) => v.entry.nodeId)
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
  const bulk = registrySpecs(queue, props.views, edits)
  const [bulkError, setBulkError] = useState('')
  const addAll = async () => {
    setBulkError('')
    const added: number[] = []
    for (const b of bulk) {
      const r = await window.skyhawk?.adoptNode(b.nodeId, b.spec)
      if (r && !r.ok) {
        setDone(new Set([...done, ...added]))
        return setBulkError(`NODE_ID ${b.nodeId}: ${r.error}`)
      }
      added.push(b.nodeId)
    }
    setDone(new Set([...done, ...added]))
  }

  if (!current) return null
  const move = (how: 'done' | 'later') => {
    if (how === 'done') setDone(new Set([...done, current.entry.nodeId]))
    const next = nextSelection(order.current, ids, current.entry.nodeId, how)
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
            {queue.map((v) => {
              const on = v.entry.nodeId === current.entry.nodeId
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
                    <Badge badge={adoptability(v.entry).badge} />
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
            key={current.entry.nodeId}
            view={current}
            views={props.views}
            dropped={dropped.has(current.entry.nodeId)}
            position={`${ids.indexOf(current.entry.nodeId) + 1} of ${ids.length}`}
            form={edits.get(current.entry.nodeId)}
            onForm={(f) => setEdits(new Map(edits).set(current.entry.nodeId, f))}
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
  view: NodeView
  views: NodeView[]
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
  const e = props.view.entry
  const id = e.nodeId
  // Only a node identified as a PDU or a panel group gets the form; anything else is shown as-is.
  const able = adoptability(e)
  const kind = able.kind
  const form =
    props.form ?? (kind ? prefill(e, kind) : prefill({ ...e, registry: undefined }, 'panel'))
  const { name, console: con, pduId } = form
  const setName = (v: string) => props.onForm({ ...form, name: v })
  const setPduId = (v: number | null | '') => props.onForm({ ...form, pduId: v })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ev = adoptEvidence(props.view)
  // #93: the PDU is explicit — one in your cockpit on another console is "(other console)"; a
  // default PDU not in your cockpit yet stays a choice, "(not added)", and the board moves under it
  // once that PDU is added.
  const { zones, pending } = adoptPduChoices(props.views, con, pduId, e)
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
            {able.note}
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
                    {pending && <option value={pduId as number}>{pending} (not added)</option>}
                  </select>
                  {pending && (
                    <div className="hint ad__pdu">
                      {pending} isn’t in your cockpit yet. Keep it and this board moves under it
                      once it’s added, or pick None.
                    </div>
                  )}
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
          onClick={() => spec && void run(() => window.skyhawk?.adoptNode(id, spec))}
        >
          {e.registry ? 'Add to cockpit' : 'Adopt'}
        </button>
      </div>
    </>
  )
}

const BADGE_CLASS: Record<ReturnType<typeof adoptability>['badge'], string> = {
  PDU: 'kind--pdu',
  'PANEL GROUP': 'kind--pg',
  IDENTIFYING: 'kind--wait',
  BRIDGE: 'kind--no',
  'UNKNOWN TYPE': 'kind--no'
}

function Badge({ badge }: { badge: ReturnType<typeof adoptability>['badge'] }) {
  return <span className={`kind ${BADGE_CLASS[badge]}`}>{badge}</span>
}
