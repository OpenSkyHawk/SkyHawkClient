import { useEffect, useMemo, useRef, useState } from 'react'
import type { NodeMappingResult } from '@shared/ipc'
import type { NodeView } from '../../cockpit'
import {
  adoptability,
  adoptEvidence,
  adoptQueue,
  adoptSpec,
  identState,
  nextSelection,
  seenAgo
} from '../../cockpit-adopt'
import { CONSOLE_OPTIONS, powerZoneOptions } from '../../cockpit-panels'
import { useModalFocus } from '../../useModalFocus'
import { Dot } from './Dot'

/**
 * New on the bus (#77): name and place each NODE_ID the registry does not know, ignore it for
 * good, or leave it for later. Esc, the scrim and Close shut it; focus returns to Adopt….
 */
export function AdoptDialog(props: { views: NodeView[]; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null)
  useModalFocus(ref, props.onClose)

  const queue = useMemo(() => adoptQueue(props.views), [props.views])
  const ids = queue.map((v) => v.entry.nodeId)
  // The queue as the dialog showed it, so "next" keeps its place as nodes leave it.
  const order = useRef<number[]>(ids)
  for (const id of ids) if (!order.current.includes(id)) order.current.push(id)
  const [sel, setSel] = useState<number | null>(ids[0] ?? null)
  const current = queue.find((v) => v.entry.nodeId === sel) ?? queue[0]

  // NODE_IDs that dropped off the bus while the dialog was open (power-cycle to identify).
  const [dropped, setDropped] = useState<ReadonlySet<number>>(new Set())
  useEffect(() => {
    const off = queue.filter((v) => v.entry.availability !== 'online').map((v) => v.entry.nodeId)
    if (off.some((id) => !dropped.has(id))) setDropped(new Set([...dropped, ...off]))
  }, [queue, dropped])

  // Nothing left to adopt (all adopted, ignored or gone): close.
  const { onClose } = props
  useEffect(() => {
    if (queue.length === 0) onClose()
  }, [queue.length, onClose])

  if (!current) return null
  const move = (how: 'done' | 'later') => {
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
              {queue.length} device{queue.length === 1 ? '' : 's'} this computer hasn’t linked yet.
              Nodes listed in NODE_IDS.md are placed automatically.
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
                  <div className="ad__im">{seenAgo(v.entry.firstSeenAt, Date.now())}</div>
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
  onDone: () => void
  onLater: () => void
}) {
  const e = props.view.entry
  const id = e.nodeId
  const [name, setName] = useState('')
  const [con, setCon] = useState('')
  const [pduId, setPduId] = useState<number | null | ''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ev = adoptEvidence(props.view)
  // Only a node identified as a PDU or a panel group gets the form; anything else can be ignored.
  const able = adoptability(e)
  const kind = able.kind
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
                  onChange={(ev) => {
                    setCon(ev.target.value)
                    setPduId('')
                  }}
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
                    {powerZoneOptions(props.views, con, null).map((o) => (
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
        {kind && (
          <div className="hint">
            Saved on this computer. To make it permanent for everyone, add NODE_ID {id} to
            NODE_IDS.md.
          </div>
        )}
        {error && <div className="set-err ad__err">{error}</div>}
      </div>
      <div className="ad__ft">
        <span className="hint ad__pos">{props.position}</span>
        <button
          className="toolbtn"
          style={{ marginLeft: 'auto' }}
          title="Never show this NODE_ID again (undo in Settings › Cockpit › Ignored nodes)"
          disabled={busy}
          onClick={() => void run(() => window.skyhawk?.ignoreNode(id, true))}
        >
          Ignore
        </button>
        <button className="toolbtn" disabled={busy} onClick={props.onLater}>
          Later
        </button>
        <button
          className="browse"
          disabled={busy || !spec}
          onClick={() => spec && void run(() => window.skyhawk?.adoptNode(id, spec))}
        >
          Adopt
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
