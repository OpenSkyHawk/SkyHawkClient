import { useEffect, useState } from 'react'
import { DASH, voltsValue } from '@shared/format'
import {
  CONSOLE_OPTIONS,
  consoleLabel,
  type BoardActions,
  type BoardPanel,
  type FaultBox,
  type NodeMappingResult,
  type NodeModelEntry,
  type NodeRegistryInfo,
  type NodeView,
  type ZoneChoices
} from '@shared/nodes'
import { Chevron, Sheet } from '../app/kit'
import { useNodesStore } from './store'
import { firstZone, mappingPatch, reportAge, zoneOptions } from './panel-view'
import { Dot } from './Dot'

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
    void useNodesStore
      .getState()
      .getNodeRegistry()
      ?.then((r) => {
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
  /** What Forget, Hide and Reset offer here (main's). */
  actions: BoardActions
  call: ReturnType<typeof useMappingCall>
  onSave: () => void
}) {
  const { e, call } = props
  const a = props.actions
  const { resetNode, forgetNode, hideNode } = useNodesStore.getState()
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
            onClick={() => void call.run(() => resetNode(e.nodeId))}
          >
            Reset to default
          </button>
        )}
        <button
          className="danger"
          title={a.forget.tip}
          disabled={call.busy || a.forget.disabled}
          onClick={() => void call.run(() => forgetNode(e.nodeId))}
        >
          Forget
        </button>
        <button
          className="danger"
          title={a.hide.tip}
          disabled={call.busy || a.hide.disabled}
          onClick={() => void call.run(() => hideNode(e.nodeId, true))}
        >
          Hide
        </button>
      </div>
      <div className="hint sh__hint">{a.note}</div>
    </>
  )
}

const pv = (live: boolean, mv?: number) => (mv !== undefined && live ? voltsValue(mv) : DASH)

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
  /** What this board's panel says and offers (main's). */
  panel: BoardPanel
  views: NodeView[]
  zones: ZoneChoices
  live: boolean
  /** Switch to another board's panel (Powered by). */
  onOpen: (nodeId: number) => void
  onClose: () => void
}) {
  const { view: v, views, panel, zones } = props
  const e = v.entry
  const [tab, setTab] = useState<'status' | 'settings'>('status')
  const pdu =
    panel.poweredBy === undefined
      ? undefined
      : views.find((p) => p.entry.nodeId === panel.poweredBy)
  // The form starts from the mapping when the panel opens; pushes while editing don't reset it.
  const [name, setName] = useState(e.name)
  const [con, setCon] = useState(e.console ?? '')
  const [pduId, setPduId] = useState<number | null>(e.pduId)
  const call = useMappingCall(props.onClose)
  const placed = panel.placed
  const now = useNow(props.live && tab === 'status')
  const age = props.live ? reportAge(e, now) : 'last known'

  const where = placed
    ? `${consoleLabel(e.console)} · ${pdu ? pdu.entry.name : 'no power zone'}`
    : 'not placed yet'
  const rails = pdu?.readings

  const save = () => {
    const patch = mappingPatch(e, { name, console: con, pduId })
    if (Object.keys(patch).length === 0) return props.onClose()
    void call.run(() => useNodesStore.getState().setNodeMapping(e.nodeId, patch))
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
          {panel.faults.map((b) => (
            <Fault key={b.title} box={b} />
          ))}
          <div className="sh__sec">
            <div className="section-h">
              Reported by the node{age && <span className="sh__age">· {age}</span>}
            </div>
            <Rows rows={panel.status ?? []} />
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
                      setPduId(firstZone(zones, c))
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
                    {zoneOptions(zones, con, pduId).map((o) => (
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
          {placed && <BoardFooter e={e} actions={panel.actions} call={call} onSave={save} />}
        </>
      )}
    </Sheet>
  )
}

// ── PDU ─────────────────────────────────────────────────────────────────────

export function PduPanel(props: {
  view: NodeView
  /** What this PDU's panel says and offers (main's). */
  panel: BoardPanel
  views: NodeView[]
  live: boolean
  /** Switch to another board's panel (Feeds). */
  onOpen: (nodeId: number) => void
  onClose: () => void
}) {
  const { view: v, views, panel } = props
  const e = v.entry
  const [tab, setTab] = useState<'status' | 'feeds' | 'settings'>('status')
  const [name, setName] = useState(e.name)
  const [con, setCon] = useState(e.console ?? '')
  const call = useMappingCall(props.onClose)
  const others = panel.sharedWith ?? []
  const feeds = (panel.feeds ?? []).flatMap((f) => {
    const n = views.find((o) => o.entry.nodeId === f.nodeId)
    return n ? [{ view: n, detail: f.detail }] : []
  })
  const rails = panel.rails ?? []
  const watts = rails.every((r) => r.watts)
    ? ` Power (W) is computed here: ${rails.map((r) => `${r.watts} W`).join(' + ')}.`
    : ''
  const placed = panel.placed

  const save = () => {
    const patch = mappingPatch(e, { name, console: con, pduId: e.pduId })
    if (Object.keys(patch).length === 0) return props.onClose()
    void call.run(() => useNodesStore.getState().setNodeMapping(e.nodeId, patch))
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
            sub={`${consoleLabel(e.console)}${others.length ? ` · shared with ${others.join(', ')}` : ''}`}
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
          {panel.faults.map((b) => (
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
            <Rows rows={panel.board ?? []} />
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
              {feeds.map((f) => (
                <BoardLink
                  key={f.view.entry.nodeId}
                  v={f.view}
                  detail={f.detail}
                  onOpen={props.onOpen}
                />
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
          {placed && <BoardFooter e={e} actions={panel.actions} call={call} onSave={save} />}
        </>
      )}
    </Sheet>
  )
}
