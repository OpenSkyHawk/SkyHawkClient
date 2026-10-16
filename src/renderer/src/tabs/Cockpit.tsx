import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isLinkUp } from '@shared/ipc'
import type { NodeModel } from '@shared/node-rules'
import { effectivePsuLimits, type PsuLimits } from '@shared/psu'
import { useStore } from '../store'
import { strayFlag, strayNew } from '../cockpit-adopt'
import {
  ATTENTION_SHOWN,
  STAGE_W,
  STATE_SYMBOL,
  attentionItems,
  fmtPct,
  headroom,
  healthBand,
  newCount,
  nodeViews,
  planLayout,
  psuName,
  tileMatches,
  type AttentionItem,
  type HealthBand,
  type Headroom,
  type NodeView,
  type PlanGroup,
  type PlanLayout
} from '../cockpit'
import { BoardEvents } from './cockpit/BoardEvents'
import { Dot } from './cockpit/Dot'
import { AdoptDialog } from './cockpit/AdoptDialog'
import { NodePanel, PduPanel } from './cockpit/SidePanels'

const RING_C = 289.03 // 2π × 46, the ring's circumference

const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const volts = (mv: number) => (mv / 1000).toFixed(2)

export function Cockpit() {
  const model = useStore((s) => s.nodeModel)
  const telemetry = useStore((s) => s.nodeTelemetry)
  const peakW = useStore((s) => s.nodesPeakW)
  const live = useStore((s) => isLinkUp(s.deviceState))
  const linkDownAt = useStore((s) => s.linkDownAt)
  const psu = useStore((s) => s.psu)
  const limits = useMemo(() => effectivePsuLimits(psu), [psu])

  const [query, setQuery] = useState('')
  const [issuesOnly, setIssuesOnly] = useState(false)
  /** A PDU group highlighted from its Attention item. */
  const [focusPdu, setFocusPdu] = useState<number | null>(null)
  /** NODE_ID whose side panel is open: the node panel, or the PDU panel for a PDU. */
  const [open, setOpen] = useState<number | null>(null)
  const [adopting, setAdopting] = useState(false)
  /** A node another tab asked to open here (Connection's "›"). */
  const pendingOpen = useStore((s) => s.cockpitOpen)
  const set = useStore((s) => s.set)
  useEffect(() => {
    if (pendingOpen === undefined) return
    setOpen(pendingOpen)
    set({ cockpitOpen: undefined })
  }, [pendingOpen, set])
  /** The Overview's new-devices notice asked for the Adopt dialog. */
  const pendingAdopt = useStore((s) => s.cockpitAdopt)
  useEffect(() => {
    if (!pendingAdopt) return
    setAdopting(true)
    set({ cockpitAdopt: undefined })
  }, [pendingAdopt, set])

  const views = useMemo(() => (model ? nodeViews(model, telemetry) : []), [model, telemetry])
  const outages = useMemo(() => model?.outages ?? [], [model])
  const layout = useMemo(() => planLayout(views, outages), [views, outages])
  // New boards that can't be adopted are active on the bus, so they are warnings (#93) — once an
  // unidentified one has had IDENTIFY_WAIT_MS to report its kind, so a normal board never flashes.
  const [now, setNow] = useState(() => Date.now())
  const stray = useMemo(() => strayNew(views, now), [views, now])
  useEffect(() => {
    if (stray.nextAt === undefined) return
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, stray.nextAt - Date.now()) + 50)
    return () => clearTimeout(t)
  }, [stray.nextAt])
  const strays = useMemo(
    () =>
      live ? stray.strays.map((v) => ({ nodeId: v.entry.nodeId, flag: strayFlag(v.entry) })) : [],
    [live, stray]
  )
  const band = useMemo(() => healthBand(views, strays.length), [views, strays])
  const items = useMemo(
    () => (live ? attentionItems(views, outages, strays) : []),
    [live, views, outages, strays]
  )
  /** The Adopt dialog opened on this NODE_ID (a stray's cog), else on the first in its queue. */
  const [adoptAt, setAdoptAt] = useState<number>()
  const openView = open === null ? undefined : views.find((v) => v.entry.nodeId === open)
  // A node can leave the model while its panel is open (hidden, forgotten): close it.
  useEffect(() => {
    if (open !== null && !openView) setOpen(null)
  }, [open, openView])

  const filter = (q: string, issues: boolean) => {
    setQuery(q)
    setIssuesOnly(issues)
    setFocusPdu(null)
  }

  return (
    <div className="cv">
      <Band band={band} live={live} peakW={peakW} linkDownAt={linkDownAt} limits={limits} />

      <div className="cv__main">
        <div>
          {!live && (
            <div className="nolink" role="status">
              <span className="node__dot" aria-hidden="true" />
              <span>
                <b>No live node status</b> — connect the SimGateway.
                {linkDownAt !== undefined && model?.nodes.length
                  ? ` Showing the last known state from ${hhmm(linkDownAt)}.`
                  : ''}
              </span>
            </div>
          )}
          <div className="plan__tools">
            <div className="plan__legend" aria-hidden="true">
              <span>
                <i style={{ background: 'var(--green)' }} />
                healthy
              </span>
              <span>
                <i style={{ background: 'var(--gold)' }} />! warning
              </span>
              <span>
                <i style={{ background: 'var(--red)' }} />✕ offline
              </span>
              <span>- - power feed</span>
            </div>
            <input
              className="input plan__find"
              placeholder="Find panel…"
              aria-label="Find panel by name or NODE_ID"
              value={query}
              onChange={(e) => filter(e.target.value, issuesOnly)}
            />
            <div className="segmini" role="group" aria-label="Show">
              <button
                className={issuesOnly ? '' : 'on'}
                aria-pressed={!issuesOnly}
                onClick={() => filter(query, false)}
              >
                All
              </button>
              <button
                className={issuesOnly ? 'on' : ''}
                aria-pressed={issuesOnly}
                onClick={() => filter(query, true)}
              >
                Issues
              </button>
            </div>
          </div>
          <Plan
            layout={layout}
            live={live}
            psuW={live ? band.watts : null}
            psuName={psuName(psu)}
            psuRating={limits.w}
            lit={(v) => tileMatches(v, query, issuesOnly)}
            focusPdu={focusPdu}
            onOpen={setOpen}
          />
        </div>

        <div className="cv__sidewrap">
          <div className="cv__side">
            <Attention
              model={model}
              live={live}
              items={items}
              onShowOutage={(pduId) => {
                setQuery('')
                setIssuesOnly(false)
                setFocusPdu(pduId)
              }}
              onShowAll={() => filter('', true)}
              onOpen={setOpen}
              onAdopt={(nodeId) => {
                setAdoptAt(nodeId)
                setAdopting(true)
              }}
            />
            <BoardEvents />
          </div>
        </div>
      </div>

      {adopting && (
        <AdoptDialog views={views} initial={adoptAt} onClose={() => setAdopting(false)} />
      )}
      {openView &&
        (openView.entry.kind === 'pdu' ? (
          <PduPanel
            key={openView.entry.nodeId}
            view={openView}
            views={views}
            outage={outages.some((o) => o.pduId === openView.entry.nodeId)}
            live={live}
            onOpen={setOpen}
            onClose={() => setOpen(null)}
          />
        ) : (
          <NodePanel
            key={openView.entry.nodeId}
            view={openView}
            views={views}
            live={live}
            onOpen={setOpen}
            onClose={() => setOpen(null)}
          />
        ))}
    </div>
  )
}

// ── health band ─────────────────────────────────────────────────────────────

/** `/ 54` after a band value: the PSU limit it is drawn against. Nothing when it is unknown. */
function Limit({ h }: { h: Headroom | null }) {
  return h && <small className="hcard__lim">/ {h.limit}</small>
}

/** Usage bar under a band value. Display only: it never changes colour or alerts. */
function Bar({ h, of }: { h: Headroom | null; of: string }) {
  if (!h) return null
  const text = h.pct !== null ? `${fmtPct(h.pct)} of ${of}` : undefined
  return (
    <div className="hbar" title={text} role={text ? 'img' : undefined} aria-label={text}>
      <i style={{ width: `${h.bar}%` }} />
    </div>
  )
}

function Band(props: {
  band: HealthBand
  live: boolean
  peakW: number
  linkDownAt?: number
  limits: PsuLimits
}) {
  const { band: b, live, limits } = props
  const h12 = headroom(live ? b.amps12 : null, limits.a12)
  const h5 = headroom(live ? b.amps5 : null, limits.a5)
  const hW = headroom(live ? b.watts : null, limits.w)
  const dash = '—'
  const offRing = b.total ? RING_C * (1 - b.online / b.total) : RING_C
  const without = `${b.pdusWithout} PDU${b.pdusWithout === 1 ? '' : 's'} without readings`
  const noLive = 'no live readings'
  const hotColor =
    b.hottest?.level === 'crit'
      ? 'var(--red)'
      : b.hottest?.level === 'warn'
        ? 'var(--gold)'
        : undefined
  const can = b.worstCan
  return (
    <div className="cv__top">
      <div className="ring">
        <div className="gauge__dial">
          <svg width="84" height="84" viewBox="0 0 110 110" aria-hidden="true">
            <circle
              cx="55"
              cy="55"
              r="46"
              fill="none"
              stroke="rgba(110,231,160,0.12)"
              strokeWidth="9"
            />
            {b.online > 0 && (
              <circle
                cx="55"
                cy="55"
                r="46"
                fill="none"
                stroke="var(--green)"
                strokeWidth="9"
                strokeLinecap="round"
                strokeDasharray={RING_C}
                strokeDashoffset={offRing.toFixed(1)}
              />
            )}
          </svg>
          <div className="gauge__center">
            <div className="gauge__value">{b.online}</div>
            <div className="gauge__unit">/ {b.total}</div>
          </div>
        </div>
        <div className="ring__txt">
          <div className="hcard__label">Nodes online</div>
          <div className="ring__sub">
            {live
              ? `${b.warn} warning · ${b.off} offline${b.unknown ? ` · ${b.unknown} no status yet` : ''}`
              : `last known${props.linkDownAt !== undefined ? ` · ${hhmm(props.linkDownAt)}` : ''}`}
          </div>
        </div>
      </div>

      <div className="hcard hcard--12v">
        <div className="hcard__label">12 V bus</div>
        <div className="hcard__value" style={{ color: 'var(--blue)' }}>
          {live && b.amps12 !== null ? `${b.amps12.toFixed(2)} A` : dash} <Limit h={h12} />
        </div>
        <Bar h={h12} of="the PSU 12 V rail" />
        <div className="ring__sub">
          {!live
            ? noLive
            : b.pdusWithout
              ? without
              : b.watts12 !== null
                ? `${b.watts12.toFixed(1)} W · ${b.pdusWith} PDU${b.pdusWith === 1 ? '' : 's'}`
                : ''}
        </div>
      </div>

      <div className="hcard hcard--5v">
        <div className="hcard__label">5 V bus</div>
        <div className="hcard__value" style={{ color: 'var(--gold)' }}>
          {live && b.amps5 !== null ? `${b.amps5.toFixed(2)} A` : dash} <Limit h={h5} />
        </div>
        <Bar h={h5} of="the PSU 5 V rail" />
        <div
          className="ring__sub"
          title={b.low5 && live ? `lowest 5 V rail: ${b.low5.name}` : undefined}
        >
          {!live ? noLive : b.low5 ? `low ${b.low5.volts.toFixed(2)} V · #${b.low5.nodeId}` : ''}
        </div>
      </div>

      <div className="hcard">
        <div className="hcard__label">Total power</div>
        <div className="hcard__value" title="V × A per rail, computed by the client">
          {live && b.watts !== null ? `${b.watts.toFixed(1)} W` : dash} <Limit h={hW} />
        </div>
        <Bar h={hW} of="the PSU rating (Settings › Cockpit › Power supply)" />
        <div className="ring__sub" title="Highest this session, computed by the client">
          {props.peakW > 0 ? `peak ${props.peakW.toFixed(1)} W` : live ? '' : noLive}
        </div>
      </div>

      <div className="hcard">
        <div className="hcard__label">CAN errors</div>
        <div className="hcard__value">
          {live && can ? (can.rec > can.tec ? `REC ${can.rec}` : `TEC ${can.tec}`) : dash}
        </div>
        <div className="ring__sub" title={live && can ? `worst: ${can.name}` : undefined}>
          {live ? `${can ? `worst #${can.nodeId} · ` : ''}${b.busOff} bus-off` : noLive}
        </div>
      </div>

      <div className="hcard">
        <div className="hcard__label">Hottest PDU</div>
        <div className="hcard__value" style={{ color: live ? hotColor : undefined }}>
          {live && b.hottest ? `${b.hottest.tempC.toFixed(1)} °C` : dash}
        </div>
        <div className="ring__sub" title="NTC near the power connections">
          {live && b.hottest ? `${b.hottest.name} · connectors` : noLive}
        </div>
      </div>
    </div>
  )
}

// ── plan ────────────────────────────────────────────────────────────────────

function Plan(props: {
  layout: PlanLayout
  live: boolean
  psuW: number | null
  /** The supply's model, or `PSU`. */
  psuName: string
  /** Rated W; undefined = unknown, the box shows the plain total. */
  psuRating?: number
  lit: (v: NodeView) => boolean
  focusPdu: number | null
  onOpen: (nodeId: number) => void
}) {
  const { layout: l } = props
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)

  // Fit the 1000-wide stage to the width the plan gets — scaled, never cropped.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => setScale(Math.min(1, (el.clientWidth - 16) / STAGE_W))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const cb = l.centerBottom
  return (
    <div
      ref={box}
      className={`plan${props.live ? '' : ' plan--dim'}`}
      style={{ height: Math.round(l.height * scale) }}
    >
      <div className="plan__stage" style={{ height: l.height, transform: `scale(${scale})` }}>
        <svg
          className="plan__bg"
          width={STAGE_W}
          height={l.height}
          viewBox={`0 0 ${STAGE_W} ${l.height}`}
          aria-hidden="true"
        >
          <path
            d={`M270 92 Q500 36 730 92 L730 ${cb} L270 ${cb} Z`}
            fill="rgba(13,22,38,0.55)"
            stroke="rgba(255,255,255,0.08)"
          />
          <path
            d="M262 92 Q500 30 738 92"
            fill="none"
            stroke="rgba(30,143,255,0.25)"
            strokeWidth="3"
          />
          {[24, 744].map((x) => (
            <rect
              key={x}
              x={x}
              y={l.sideBox.y}
              width="232"
              height={l.sideBox.h}
              rx="16"
              fill="rgba(13,22,38,0.55)"
              stroke="rgba(255,255,255,0.08)"
            />
          ))}
          {l.wires.map((w) => (
            <path key={w.d} className={`wire${w.alert ? ' wire--alert' : ''}`} d={w.d} />
          ))}
        </svg>

        {l.consoles.map((c) => (
          <div key={c.key} className="con__t" style={{ left: c.x, top: c.y }}>
            {c.title}
            {c.sub && <small>{c.sub}</small>}
          </div>
        ))}
        {l.groups.map((g) => (
          <Group
            key={g.key}
            g={g}
            focused={g.pdu !== null && g.pdu.entry.nodeId === props.focusPdu}
            lit={props.lit}
            onOpen={props.onOpen}
          />
        ))}
        <div className="psu" style={{ left: l.psu.x, top: l.psu.y }}>
          {props.psuRating !== undefined ? (
            <>
              {props.psuName} · <b>{props.psuW !== null ? props.psuW.toFixed(1) : '—'}</b> /{' '}
              {props.psuRating} W
            </>
          ) : (
            <>
              PSU · <b>{props.psuW !== null ? `${props.psuW.toFixed(1)} W` : '—'}</b>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Group(props: {
  g: PlanGroup
  focused: boolean
  lit: (v: NodeView) => boolean
  onOpen: (nodeId: number) => void
}) {
  const { g, focused } = props
  const p = g.pdu
  const off = p?.health.state === 'off'
  const dash = !p || off || p.noReadings
  const r12 = p?.readings.rail12V
  const r5 = p?.readings.rail5V
  const rails = (
    <>
      12 V{' '}
      <b className={!dash && r12?.flags ? 'alert' : ''}>{!dash && r12 ? volts(r12.vAvgMv) : '—'}</b>
      {g.wide ? ' · ' : ' '}5 V{' '}
      <b className={!dash && r5?.flags ? 'alert' : ''}>{!dash && r5 ? volts(r5.vAvgMv) : '—'}</b>
    </>
  )
  const flags = off
    ? ['OFFLINE']
    : p?.health.state === 'warn'
      ? (p.health.flag ?? '').split(' · ')
      : []
  // One flag fits the header; the rest are counted, and all of them are in the tooltip.
  const alert = flags.length ? flags[0] + (flags.length > 1 ? ` +${flags.length - 1}` : '') : ''
  const cls = `gh${off ? ' gh--off' : ''}${focused ? ' gh--focus' : ''}`
  const style = { left: g.x, top: g.y, width: g.w }
  const head = (
    <>
      <span className="gh__l">
        {p ? <Dot state={p.health.state} /> : <span className="node__dot" aria-hidden="true" />}
        <span className="gh__n">{p ? p.entry.name : 'No power zone'}</span>
        {p && `#${p.entry.nodeId}`}
        {alert && (
          <b className={`flag ${off ? 'flag--err' : 'flag--warn'}`} title={flags.join(' · ')}>
            {alert}
          </b>
        )}
        {p?.noReadings && !off && <span className="nr">no readings</span>}
        {p && g.wide && <span className="gh__rails">{rails}</span>}
      </span>
      {p && !g.wide && <span className="gh__l">{rails}</span>}
    </>
  )
  return (
    <>
      {p ? (
        <button
          className={cls}
          style={style}
          title={`${p.entry.name} — power zone details`}
          onClick={() => props.onOpen(p.entry.nodeId)}
        >
          {head}
        </button>
      ) : (
        <div className={cls} style={style}>
          {head}
        </div>
      )}
      {g.tiles.map((t) => {
        const { state, flag } = t.view.health
        const tcls =
          state === 'off'
            ? ' tile2--off'
            : state === 'warn'
              ? ' tile2--warn'
              : state === 'unknown'
                ? ' tile2--unknown'
                : ''
        const tip = flag ? ` — ${flag}` : state === 'unknown' ? ' — no status yet' : ''
        return (
          <button
            key={t.view.entry.nodeId}
            className={`tile2${tcls}${props.lit(t.view) ? '' : ' tile2--dim'}${focused ? ' tile2--focus' : ''}`}
            style={{ left: t.x, top: t.y, width: t.w }}
            title={`#${t.view.entry.nodeId} ${t.view.entry.name}${tip}`}
            onClick={() => props.onOpen(t.view.entry.nodeId)}
          >
            <span className="tile2__t">{t.short}</span>
            <span className="tile2__s" aria-label={flag}>
              {STATE_SYMBOL[state]}
            </span>
          </button>
        )
      })}
      {g.hint && (
        <div className="grp__hint" style={{ left: g.x, top: g.hint.y, width: g.w }}>
          {g.hint.text}
        </div>
      )}
    </>
  )
}

// ── Attention ───────────────────────────────────────────────────────────────

function Attention(props: {
  model?: NodeModel
  live: boolean
  items: AttentionItem[]
  onShowOutage: (pduId: number) => void
  onShowAll: () => void
  onOpen: (nodeId: number) => void
  /** Open the Adopt dialog, on this NODE_ID when given. */
  onAdopt: (nodeId?: number) => void
}) {
  const { items, live } = props
  const fresh = props.model ? newCount(props.model) : 0
  const more = Math.max(0, items.length - ATTENTION_SHOWN)
  return (
    <div className="card field">
      <div className="panel-h">
        <span className="section-h">Attention</span>
        <span className="meta">
          {items.length} item{items.length === 1 ? '' : 's'}
        </span>
      </div>
      {fresh > 0 && (
        <div className="adopt-cta">
          <Dot state="new" />
          <div>
            <b>New on the bus · {fresh}</b>
            <br />
            <span>not linked yet</span>
          </div>
          <button className="browse adopt-cta__btn" onClick={() => props.onAdopt()}>
            Adopt…
          </button>
        </div>
      )}
      {!live ? (
        <div className="hint">No live node status — connect the SimGateway.</div>
      ) : items.length === 0 ? (
        <div className="hint">Nothing needs attention.</div>
      ) : (
        <ul className="evt att">
          {items.slice(0, ATTENTION_SHOWN).map((i) => (
            <li key={i.key}>
              <Dot state={i.state} />
              <span className="att__t">
                <b>{i.name}</b>
                <br />
                <span>
                  {i.flag} · #{i.nodeId}
                </span>
              </span>
              {/* The cog opens the board's panel. For a PDU outage it opens the PDU's, and the
                  plan also outlines that PDU's group: the nodes that dropped with it. A board that
                  can't be adopted has no panel: its cog opens the Adopt dialog on it. */}
              <button
                className="cog"
                title={i.stray ? 'Review' : 'Details'}
                aria-label={`${i.name} ${i.stray ? 'review' : 'details'}`}
                onClick={() => {
                  if (i.stray) return props.onAdopt(i.nodeId)
                  if (i.outage) props.onShowOutage(i.nodeId)
                  props.onOpen(i.nodeId)
                }}
              >
                <CogIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
      {live && more > 0 && (
        <div className="more">
          <span>+{more} more</span>
          <button className="toolbtn" onClick={props.onShowAll}>
            Show all on map
          </button>
        </div>
      )}
    </div>
  )
}

function CogIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}
