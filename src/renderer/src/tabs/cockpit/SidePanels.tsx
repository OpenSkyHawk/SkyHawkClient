import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { NodeMappingResult, NodeRegistryInfo } from '@shared/ipc'
import type { NodeModelEntry } from '@shared/node-rules'
import type { NodeView } from '../../cockpit'
import {
  boardActions,
  CONSOLE_OPTIONS,
  consoleLabel,
  firstPduOn,
  mappingPatch,
  nodeFaultBoxes,
  nodeStatusRows,
  pduBoardRows,
  pduFaultBoxes,
  pduRailRows,
  powerZoneOptions,
  reportAge,
  type FaultBox
} from '../../cockpit-panels'
import { useModalFocus } from '../../useModalFocus'
import { Dot } from './Dot'

/**
 * Side panel under the title bar: Esc, the scrim and Close shut it; focus returns to its opener.
 * A column (#93): the header, the board line and the tabs stay put on every tab; only the body
 * under them scrolls — or, with `fill`, a list inside it (the PDU's Feeds) takes what is left.
 */
function Sheet(props: {
  label: string
  heading: string
  onClose: () => void
  /** Board head, sub-line and tabs: fixed above the body. */
  top: ReactNode
  fill?: boolean
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
        {props.top}
        <div className={`sh__body${props.fill ? ' sh__body--fill' : ''}`}>{props.children}</div>
      </aside>
    </>
  )
}

function Fault({ box }: { box: FaultBox }) {
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

// ── shared by every board panel (#93) ────────────────────────────────────────

/** Name, NODE_ID and where it sits — the same line at the top of every board's panel. */
function BoardHead(props: { v: NodeView; sub: string; live: boolean }) {
  const e = props.v.entry
  return (
    <>
      <div className="sh__head">
        <Dot state={props.v.health.state} />
        <span className="sh__title">{e.name}</span>
        <span className="zone__id">#{e.nodeId}</span>
      </div>
      <div className="sh__sub">
        {props.sub}
        {props.live ? '' : ' · last known'}
      </div>
    </>
  )
}

function Tabs<T extends string>(props: {
  label: string
  tabs: { key: T; label: string }[]
  tab: T
  onTab: (t: T) => void
}) {
  return (
    <div className="sh__tabs">
      <div
        className="segmini"
        role="tablist"
        aria-label={props.label}
        style={{ gridTemplateColumns: `repeat(${props.tabs.length}, 1fr)` }}
      >
        {props.tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={props.tab === t.key}
            className={props.tab === t.key ? 'on' : ''}
            onClick={() => props.onTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Chevron() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

/** One board as a row — the PDU's Feeds, a panel group's Powered by: opening it switches panel. */
function BoardLink(props: { v: NodeView; detail: string; onOpen: (nodeId: number) => void }) {
  const e = props.v.entry
  return (
    <li>
      <Dot state={props.v.health.state} />
      <span className="att__t">
        <b>{e.name}</b>
        <br />
        <span>
          {props.detail} · #{e.nodeId}
        </span>
      </span>
      <button
        className="cog"
        title={`Open ${e.name}`}
        aria-label={`Open ${e.name}`}
        onClick={() => props.onOpen(e.nodeId)}
      >
        <Chevron />
      </button>
    </li>
  )
}

/** Display name, and where its defaults come from. */
function NameField(props: {
  id: string
  e: NodeModelEntry
  value: string
  onChange: (v: string) => void
  extra?: string
}) {
  const reg = useRegistryEntry(props.e.nodeId)
  const from =
    props.e.source === 'registry'
      ? `Registry: ${reg ? `${reg.name}, ${consoleLabel(reg.console)}` : '…'} (NODE_IDS.md).`
      : props.e.source === 'adopted'
        ? 'Adopted on this computer — not in NODE_IDS.md.'
        : 'Not in NODE_IDS.md.'
  return (
    <div className="sh__sec">
      <label className="input-label" htmlFor={props.id}>
        Display name
      </label>
      <input
        id={props.id}
        className="input"
        value={props.value}
        onChange={(ev) => props.onChange(ev.target.value)}
      />
      <div className="hint sh__hint">{props.extra ? `${from} ${props.extra}` : from}</div>
    </div>
  )
}

function ConsoleSelect(props: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <select
      id={props.id}
      className="input"
      value={props.value}
      onChange={(ev) => props.onChange(ev.target.value)}
    >
      {!CONSOLE_OPTIONS.some((c) => c.value === props.value) && (
        <option value={props.value}>{consoleLabel(props.value)}</option>
      )}
      {CONSOLE_OPTIONS.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  )
}

/**
 * One footer for every board (#93): Save and Reset to default on the left, Forget and Hide — the
 * two ways off the display — on the right, both offline only. A button that can't be used is
 * greyed out with the reason, never left out; the line under it says what Forget and Hide do.
 */
function BoardFooter(props: {
  e: NodeModelEntry
  fed?: number
  call: ReturnType<typeof useMappingCall>
  onSave: () => void
}) {
  const { e, call } = props
  const a = boardActions(e, props.fed)
  const api = window.skyhawk
  return (
    <>
      {call.error && <div className="set-err sh__err">{call.error}</div>}
      <div className="sh__foot">
        <button className="browse" disabled={call.busy} onClick={props.onSave}>
          Save
        </button>
        {a.reset && (
          <button
            className="toolbtn"
            title={a.reset.tip}
            disabled={call.busy || a.reset.disabled}
            onClick={() => void call.run(() => api?.resetNode(e.nodeId))}
          >
            Reset to default
          </button>
        )}
        <button
          className="danger"
          title={a.forget.tip}
          disabled={call.busy || a.forget.disabled}
          onClick={() => void call.run(() => api?.forgetNode(e.nodeId))}
        >
          Forget
        </button>
        <button
          className="danger"
          title={a.hide.tip}
          disabled={call.busy || a.hide.disabled}
          onClick={() => void call.run(() => api?.hideNode(e.nodeId, true))}
        >
          Hide
        </button>
      </div>
      <div className="hint sh__hint">{a.note}</div>
    </>
  )
}

const pv = (live: boolean, mv?: number) => (mv !== undefined && live ? (mv / 1000).toFixed(2) : '—')

/** The clock, once a second while `on` — for "updated N s ago". */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

// ── panel group ─────────────────────────────────────────────────────────────

export function NodePanel(props: {
  view: NodeView
  views: NodeView[]
  live: boolean
  /** Switch to another board's panel (Powered by). */
  onOpen: (nodeId: number) => void
  onClose: () => void
}) {
  const { view: v, views } = props
  const e = v.entry
  const [tab, setTab] = useState<'status' | 'settings'>('status')
  const pdu = views.find((p) => p.entry.kind === 'pdu' && p.entry.nodeId === e.pduId)
  // The form starts from the mapping when the panel opens; pushes while editing don't reset it.
  const [name, setName] = useState(e.name)
  const [con, setCon] = useState(e.console ?? '')
  const [pduId, setPduId] = useState<number | null>(e.pduId)
  const call = useMappingCall(props.onClose)
  const placed = e.source !== 'new'
  const now = useNow(props.live && tab === 'status')
  const age = props.live ? reportAge(e, now) : 'last known'

  const where = placed
    ? `${consoleLabel(e.console)} · ${pdu ? pdu.entry.name : 'no power zone'}`
    : 'not placed yet'
  const rails = pdu?.readings

  const save = () => {
    const patch = mappingPatch(e, { name, console: con, pduId })
    if (Object.keys(patch).length === 0) return props.onClose()
    void call.run(() => window.skyhawk?.setNodeMapping(e.nodeId, patch))
  }

  return (
    <Sheet
      label={`Panel group ${e.name}`}
      heading="Panel group"
      onClose={props.onClose}
      top={
        <>
          <BoardHead v={v} sub={where} live={props.live} />
          <Tabs
            label="Panel group"
            tabs={[
              { key: 'status', label: 'Status' },
              { key: 'settings', label: 'Settings' }
            ]}
            tab={tab}
            onTab={setTab}
          />
        </>
      }
    >
      {tab === 'status' ? (
        <>
          {nodeFaultBoxes(v).map((b) => (
            <Fault key={b.title} box={b} />
          ))}
          <div className="sh__sec">
            <div className="section-h">
              Reported by the node{age && <span className="sh__age">· {age}</span>}
            </div>
            <Rows rows={nodeStatusRows(v)} />
          </div>
          {placed && (
            <div className="sh__sec">
              <div className="section-h">Powered by</div>
              {pdu ? (
                <ul className="evt att">
                  <BoardLink
                    v={pdu}
                    detail={`12 V ${pv(props.live, rails?.rail12V?.vAvgMv)} · 5 V ${pv(props.live, rails?.rail5V?.vAvgMv)}`}
                    onOpen={props.onOpen}
                  />
                </ul>
              ) : (
                <div className="hint">No power zone. Pick one in the Settings tab.</div>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <NameField id="np-name" e={e} value={name} onChange={setName} />
          {placed && (
            <div className="sh__sec">
              <div className="section-h">Placement · this computer</div>
              <div className="sh__row">
                <div>
                  <label className="input-label" htmlFor="np-console">
                    Console
                  </label>
                  <ConsoleSelect
                    id="np-console"
                    value={con}
                    onChange={(c) => {
                      setCon(c)
                      setPduId(firstPduOn(views, c))
                    }}
                  />
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
          {placed && <BoardFooter e={e} call={call} onSave={save} />}
        </>
      )}
    </Sheet>
  )
}

// ── PDU ─────────────────────────────────────────────────────────────────────

export function PduPanel(props: {
  view: NodeView
  views: NodeView[]
  outage: boolean
  live: boolean
  /** Switch to another board's panel (Feeds). */
  onOpen: (nodeId: number) => void
  onClose: () => void
}) {
  const { view: v, views } = props
  const e = v.entry
  const [tab, setTab] = useState<'status' | 'feeds' | 'settings'>('status')
  const [name, setName] = useState(e.name)
  const [con, setCon] = useState(e.console ?? '')
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
  const placed = e.source !== 'new'

  const save = () => {
    const patch = mappingPatch(e, { name, console: con, pduId: e.pduId })
    if (Object.keys(patch).length === 0) return props.onClose()
    void call.run(() => window.skyhawk?.setNodeMapping(e.nodeId, patch))
  }

  return (
    <Sheet
      label={`PDU ${e.name}`}
      heading="PDU"
      onClose={props.onClose}
      fill={tab === 'feeds'}
      top={
        <>
          <BoardHead
            v={v}
            sub={`${consoleLabel(e.console)}${others.length ? ` · shared with ${others.map((o) => o.entry.name).join(', ')}` : ''}`}
            live={props.live}
          />
          <Tabs
            label="PDU"
            tabs={[
              { key: 'status', label: 'Status' },
              { key: 'feeds', label: `Feeds · ${feeds.length}` },
              { key: 'settings', label: 'Settings' }
            ]}
            tab={tab}
            onTab={setTab}
          />
        </>
      }
    >
      {tab === 'status' && (
        <>
          {pduFaultBoxes(v, props.outage).map((b) => (
            <Fault key={b.title} box={b} />
          ))}
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
        </>
      )}

      {tab === 'feeds' && (
        <div className="sh__sec sh__sec--fill">
          <div className="section-h">Boards on this PDU</div>
          {feeds.length ? (
            <ul className="evt att sh__list">
              {feeds.map((n) => (
                <BoardLink key={n.entry.nodeId} v={n} detail={feedState(n)} onOpen={props.onOpen} />
              ))}
            </ul>
          ) : (
            <div className="hint">No board has this PDU as its power zone.</div>
          )}
          <div className="hint sh__hint">
            Which boards a PDU feeds is set in each board’s Settings tab (power zone). Opening one
            switches to its panel.
          </div>
        </div>
      )}

      {tab === 'settings' && (
        <>
          <NameField
            id="pp-name"
            e={e}
            value={name}
            onChange={setName}
            extra="Also the group header on the plan."
          />
          {placed && (
            <div className="sh__sec">
              <div className="section-h">Placement · this computer</div>
              <div className="sh__row">
                <div>
                  <label className="input-label" htmlFor="pp-console">
                    Console
                  </label>
                  <ConsoleSelect id="pp-console" value={con} onChange={setCon} />
                </div>
              </div>
              <div className="hint">
                A PDU has no power zone. Moving it to another console moves its group, and the
                boards it powers, with it on the plan.
              </div>
            </div>
          )}
          {placed && <BoardFooter e={e} fed={feeds.length} call={call} onSave={save} />}
        </>
      )}
    </Sheet>
  )
}

/** A fed board's state in the Feeds list: its flag, else online / no status yet. */
function feedState(v: NodeView): string {
  const e = v.entry
  if (e.notSeen) return 'not seen this session'
  if (v.health.flag) return v.health.flag
  return v.health.state === 'unknown' ? 'no status yet' : 'online'
}
