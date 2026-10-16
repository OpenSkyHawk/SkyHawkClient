import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { NodeMappingResult, NodeRegistryInfo } from '@shared/ipc'
import { shortName, type NodeView } from '../../cockpit'
import {
  CONSOLE_OPTIONS,
  consoleLabel,
  firstPduOn,
  mappingPatch,
  nodeActions,
  nodeFaultBox,
  nodeStatusRows,
  pduBoardRows,
  pduFaultBox,
  pduRailRows,
  powerZoneOptions,
  type FaultBox,
  type NodeAction
} from '../../cockpit-panels'
import { useModalFocus } from '../../useModalFocus'
import { Dot } from './Dot'

/** Side panel under the title bar: Esc, the scrim and Close shut it; focus returns to its opener. */
function Sheet(props: {
  label: string
  heading: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLElement>(null)
  useModalFocus(ref, props.onClose)
  return (
    <>
      <div className="sheet__scrim" onClick={props.onClose} />
      <aside
        ref={ref}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        tabIndex={-1}
      >
        <div className="panel-h sheet__h">
          <span className="section-h">{props.heading}</span>
          <button className="toolbtn" onClick={props.onClose}>
            Close
          </button>
        </div>
        {props.children}
      </aside>
    </>
  )
}

function Fault({ box }: { box: FaultBox | null }) {
  if (!box) return null
  return (
    <div className={`sh__fault sh__fault--${box.tone}`}>
      <b>{box.title}</b> — {box.text}
    </div>
  )
}

function Rows({ rows }: { rows: { k: string; v: string }[] }) {
  return (
    <>
      {rows.map((r) => (
        <div className="dev__row" key={r.k}>
          <span className="dev__k">{r.k}</span>
          <span className="dev__v">{r.v}</span>
        </div>
      ))}
    </>
  )
}

/** Runs one mapping invoke: closes the panel on success, keeps the error to show inline. */
function useMappingCall(onDone: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (call: () => Promise<NodeMappingResult> | undefined) => {
    setBusy(true)
    setError('')
    const r = await call()
    setBusy(false)
    if (!r) return setError('Not connected to the client process.')
    if (r.ok) onDone()
    else setError(r.error)
  }
  return { busy, error, run }
}

/** Registry defaults (name, console), fetched once per panel; undefined until they arrive. */
function useRegistryEntry(nodeId: number) {
  const [reg, setReg] = useState<NodeRegistryInfo>()
  useEffect(() => {
    let live = true
    void window.skyhawk?.getNodeRegistry().then((r) => {
      if (live) setReg(r)
    })
    return () => {
      live = false
    }
  }, [])
  return reg?.nodes.find((n) => n.nodeId === nodeId)
}

// ── node panel ──────────────────────────────────────────────────────────────

const ACTION: Record<NodeAction, { label: string; tip: string; danger?: boolean }> = {
  reset: {
    label: 'Reset to default',
    tip: 'Restore the name, console and power zone from NODE_IDS.md'
  },
  forget: { label: 'Forget', tip: 'Un-adopt: it shows as new again' },
  hide: {
    label: 'Hide until it reports again',
    tip: 'Removed or replaced: hide it until it reports again',
    danger: true
  },
  ignore: {
    label: 'Ignore permanently',
    tip: 'Never show this NODE_ID again (undo in Settings › Cockpit)',
    danger: true
  }
}

export function NodePanel(props: {
  view: NodeView
  views: NodeView[]
  live: boolean
  onClose: () => void
}) {
  const { view: v, views } = props
  const e = v.entry
  const [tab, setTab] = useState<'status' | 'settings'>('status')
  const pdu = views.find((p) => p.entry.kind === 'pdu' && p.entry.nodeId === e.pduId)
  const reg = useRegistryEntry(e.nodeId)
  // The form starts from the mapping when the panel opens; pushes while editing don't reset it.
  const [name, setName] = useState(e.name)
  const [con, setCon] = useState(e.console ?? '')
  const [pduId, setPduId] = useState<number | null>(e.pduId)
  const call = useMappingCall(props.onClose)
  const api = window.skyhawk

  const where =
    e.source === 'new'
      ? 'not placed yet'
      : `${consoleLabel(e.console)} · ${pdu ? pdu.entry.name : 'no power zone'}`
  const rails = pdu?.readings
  const pv = (mv?: number) => (mv !== undefined && props.live ? (mv / 1000).toFixed(2) : '—')

  const save = () => {
    const patch = mappingPatch(e, { name, console: con, pduId })
    if (Object.keys(patch).length === 0) return props.onClose()
    void call.run(() => api?.setNodeMapping(e.nodeId, patch))
  }
  const act = (a: NodeAction) =>
    void call.run(() =>
      a === 'hide'
        ? api?.hideNode(e.nodeId, true)
        : a === 'ignore'
          ? api?.ignoreNode(e.nodeId, true)
          : api?.forgetNode(e.nodeId)
    )

  return (
    <Sheet label={`Node ${e.name}`} heading="Node" onClose={props.onClose}>
      <div className="sh__head">
        <Dot state={v.health.state} />
        <span className="sh__title">{e.name}</span>
        <span className="zone__id">#{e.nodeId}</span>
      </div>
      <div className="sh__sub">
        {where}
        {props.live ? '' : ' · last known'}
      </div>
      <div className="sh__tabs">
        <div className="segmini" role="tablist" aria-label="Node panel">
          <button
            role="tab"
            aria-selected={tab === 'status'}
            className={tab === 'status' ? 'on' : ''}
            onClick={() => setTab('status')}
          >
            Status
          </button>
          <button
            role="tab"
            aria-selected={tab === 'settings'}
            className={tab === 'settings' ? 'on' : ''}
            onClick={() => setTab('settings')}
          >
            Settings
          </button>
        </div>
      </div>

      {tab === 'status' ? (
        <>
          <Fault box={nodeFaultBox(v)} />
          <div className="sh__sec">
            <div className="section-h">Reported by the node{props.live ? '' : ' · last known'}</div>
            <Rows rows={nodeStatusRows(v)} />
          </div>
          <div className="sh__sec">
            <div className="section-h">Powered by · your mapping</div>
            <div className="dev__row">
              <span className="dev__k">{pdu ? pdu.entry.name : '— none'}</span>
              <span className="dev__v">
                {pdu ? `12 V ${pv(rails?.rail12V?.vAvgMv)} · 5 V ${pv(rails?.rail5V?.vAvgMv)}` : ''}
              </span>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="sh__sec">
            <label className="input-label" htmlFor="np-name">
              Display name
            </label>
            <input
              id="np-name"
              className="input"
              value={name}
              onChange={(ev) => setName(ev.target.value)}
            />
            <div className="hint sh__hint">
              {e.source === 'registry'
                ? `Registry: ${reg ? `${reg.name}, ${consoleLabel(reg.console)}` : '…'} (NODE_IDS.md)`
                : e.source === 'adopted'
                  ? 'Adopted on this computer — not in NODE_IDS.md'
                  : 'Not in NODE_IDS.md'}
            </div>
          </div>
          {e.kind === 'panel' && e.source !== 'new' && (
            <div className="sh__sec">
              <div className="section-h">Placement · this computer</div>
              <div className="sh__row">
                <div>
                  <label className="input-label" htmlFor="np-console">
                    Console
                  </label>
                  <select
                    id="np-console"
                    className="input"
                    value={con}
                    onChange={(ev) => {
                      setCon(ev.target.value)
                      setPduId(firstPduOn(views, ev.target.value))
                    }}
                  >
                    {!CONSOLE_OPTIONS.some((c) => c.value === con) && (
                      <option value={con}>{consoleLabel(con)}</option>
                    )}
                    {CONSOLE_OPTIONS.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="input-label" htmlFor="np-zone">
                    Power zone
                  </label>
                  <select
                    id="np-zone"
                    className="input"
                    value={pduId ?? ''}
                    onChange={(ev) => setPduId(ev.target.value ? Number(ev.target.value) : null)}
                  >
                    <option value="">None</option>
                    {powerZoneOptions(views, con, pduId).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="hint">
                Defaults come from NODE_IDS.md. Changing the power zone moves the tile to that PDU
                on the plan; picking a console picks its first PDU.
              </div>
            </div>
          )}
          {call.error && <div className="set-err sh__err">{call.error}</div>}
          <div className="sh__foot">
            <button className="browse" disabled={call.busy} onClick={save}>
              Save
            </button>
            {nodeActions(e).map((a) => (
              <button
                key={a}
                className={ACTION[a].danger ? 'danger' : 'toolbtn'}
                title={
                  a === 'reset' && !e.differs
                    ? 'Already at the NODE_IDS.md defaults'
                    : ACTION[a].tip
                }
                disabled={call.busy || (a === 'reset' && !e.differs)}
                onClick={() => act(a)}
              >
                {ACTION[a].label}
              </button>
            ))}
          </div>
        </>
      )}
    </Sheet>
  )
}

// ── PDU panel ───────────────────────────────────────────────────────────────

export function PduPanel(props: {
  view: NodeView
  views: NodeView[]
  outage: boolean
  live: boolean
  onClose: () => void
}) {
  const { view: v, views } = props
  const e = v.entry
  const [name, setName] = useState(e.name)
  const call = useMappingCall(props.onClose)
  const others = views.filter(
    (p) =>
      p.entry.kind === 'pdu' &&
      p.entry.source !== 'new' &&
      p.entry.console === e.console &&
      p.entry.nodeId !== e.nodeId
  )
  const feeds = views.filter(
    (n) => n.entry.kind === 'panel' && n.entry.source !== 'new' && n.entry.pduId === e.nodeId
  )
  const rails = pduRailRows(v)
  const watts = rails.every((r) => r.watts)
    ? ` Power (W) is computed here: ${rails.map((r) => `${r.watts} W`).join(' + ')}.`
    : ''

  const save = () => {
    const patch = mappingPatch(e, { name, console: e.console ?? '', pduId: e.pduId })
    if (Object.keys(patch).length === 0) return props.onClose()
    void call.run(() => window.skyhawk?.setNodeMapping(e.nodeId, patch))
  }

  return (
    <Sheet label={`Power zone ${e.name}`} heading="Power zone" onClose={props.onClose}>
      <div className="sh__head">
        <Dot state={v.health.state} />
        <span className="sh__title">{e.name}</span>
        <span className="zone__id">#{e.nodeId}</span>
      </div>
      <div className="sh__sub">
        {consoleLabel(e.console)}
        {others.length ? ` · shared with ${others.map((o) => o.entry.name).join(', ')}` : ''}
        {props.live ? '' : ' · last known'}
      </div>
      <Fault box={pduFaultBox(v, props.outage)} />

      <div className="sh__sec">
        <div className="section-h">Rails · {props.live ? 'live' : 'last known'}</div>
        {rails.map((r) => (
          <div className={`rl${r.flagged ? ' rl--alert' : ''}`} key={r.rail}>
            <span className="rl__k">{r.rail}</span>
            <span>
              avg <b>{r.avg}</b> V
            </span>
            <span>
              min <b>{r.min}</b> V
            </span>
            <span>
              <b>{r.amps}</b> A
            </span>
            <span>
              peak <b>{r.peak}</b> A
            </span>
          </div>
        ))}
        <div className="hint sh__hint">3-second window per page.{watts}</div>
      </div>

      <div className="sh__sec">
        <div className="section-h">Board status</div>
        <Rows rows={pduBoardRows(v)} />
        <div className="hint">
          Limits and fuses are fixed in the PDU firmware. Calibrate at the bench over serial.
        </div>
      </div>

      <div className="sh__sec">
        <div className="section-h">
          Feeds · {feeds.length} node{feeds.length === 1 ? '' : 's'}
        </div>
        {feeds.length ? (
          <div className="chips2">
            {feeds.map((n) => (
              <span key={n.entry.nodeId}>{shortName(n.entry.name)}</span>
            ))}
          </div>
        ) : (
          <div className="hint">No node has this PDU as its power zone.</div>
        )}
      </div>

      <div className="sh__sec">
        <label className="input-label" htmlFor="pp-name">
          Display name
        </label>
        <input
          id="pp-name"
          className="input"
          value={name}
          onChange={(ev) => setName(ev.target.value)}
        />
        <div className="hint sh__hint">Also the group header on the plan.</div>
      </div>
      {call.error && <div className="set-err sh__err">{call.error}</div>}
      <div className="sh__foot">
        <button className="browse" disabled={call.busy} onClick={save}>
          Save
        </button>
      </div>
    </Sheet>
  )
}
