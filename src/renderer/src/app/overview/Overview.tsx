import { fmtBytes, fmtUptime } from '@shared/format'
import type { DeviceState } from '@shared/gateway'
import type { GaugeTone, OverviewLink } from '@shared/dcs'
import { useConfigStore, viewTransport } from '../../config'
import { endpointText, relaySide, useDcsStore } from '../../dcs'
import { gatewayView, useGatewayStore } from '../../gateway'
import { Dot, useNodesStore } from '../../nodes'
import { useNav, type TabId } from '../kit'
import { newDevicesText } from './overview-view'
import logo from '../assets/logo.png'

const C = 289.03 // 2·π·46

const LINK_VALUE: Record<DeviceState, string> = {
  connected: 'Connected',
  scanning: 'Scanning',
  reconnecting: 'Reconnecting',
  'no-device': 'No device',
  disconnected: 'Disconnected',
  error: 'Error'
}
const LINK_COLOR: Partial<Record<DeviceState, string>> = {
  connected: 'var(--green)',
  scanning: 'var(--blue-2)',
  reconnecting: 'var(--gold)',
  error: 'var(--red)'
}
const TILE_TONE = { ok: 'var(--green)', issue: 'var(--gold)', none: 'var(--muted)' } as const
/** The Link tile's sub-line: the relay under the device link (main's call, R3.3). */
const LINK_SUB: Record<OverviewLink, string> = {
  'gateway-relaying': 'Gateway · relaying',
  'gateway-stopped': 'Gateway · stream stopped',
  waiting: 'relay waiting — resumes when it connects',
  stopped: 'stream stopped'
}
/** A gauge ring's colour, for its level as main judges it (R3.3). */
const GAUGE_COLOR: Record<GaugeTone, string> = {
  'fuel-low': 'var(--red)',
  fuel: 'var(--gold)',
  secondary: 'var(--blue-2)',
  primary: 'var(--blue)'
}

function Gauge({
  label,
  value,
  unit,
  pct,
  color
}: {
  label: string
  value: string
  unit: string
  pct: number
  color: string
}) {
  const off = (C * (1 - Math.max(0, Math.min(1, pct)))).toFixed(1)
  return (
    <div className="gauge">
      <div className="gauge__dial">
        <svg width="110" height="110" viewBox="0 0 110 110">
          <circle
            cx="55"
            cy="55"
            r="46"
            fill="none"
            stroke="rgba(30,143,255,0.12)"
            strokeWidth="8"
          />
          <circle
            cx="55"
            cy="55"
            r="46"
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={off}
            style={{ transition: 'stroke-dashoffset 0.6s ease' }}
          />
        </svg>
        <div className="gauge__center">
          <div className="gauge__value">{value}</div>
          <div className="gauge__unit">{unit}</div>
        </div>
      </div>
      <div className="gauge__label">{label}</div>
    </div>
  )
}

/** The Overview tab: a summary of every topic — the link, the relay and stream, the cockpit. */
export function Overview() {
  const cfg = useConfigStore()
  const dcs = useDcsStore()
  const gw = useGatewayStore()
  const nodes = useNodesStore()
  const nav = useNav()
  // The transport the relay's facts were judged against (R3.4c), as its endpoint below is.
  const transport = viewTransport(dcs.relayFacts.transport)
  const link = transport === 'tcp' ? 'TCP' : transport === 'loop' ? 'Multicast' : 'Unicast'
  // The DCS Link tile's endpoint and the Link tile's sub-line are main's (relay:facts, R3.3).
  const linkSub = endpointText(dcs.relayFacts.endpoint.overview, cfg.host, cfg.port)
  const relaySub = LINK_SUB[relaySide(dcs.relayFacts, dcs.relaying).overviewLink]

  const acft = dcs.aircraft.name && dcs.aircraft.name !== 'NONE' ? dcs.aircraft.name : 'NONE'
  const acftSub = dcs.aircraft.inferred ? 'inferred · address range' : '_ACFT_NAME · metadata'

  // The Cockpit's own picture (#63), summed up for the tile and the banners (#65): main's snapshot
  // (cockpit:snapshot, R3.2b). The banner also follows Settings › Cockpit's toggle.
  const summary = nodes.cockpit.overview
  const cockpit = summary.tile
  const attention = cfg.attentionBanner ? summary.banner : null
  // Serious Gateway faults only (#94): panel input can't reach DCS. Its own link, so not behind the
  // board-problems setting.
  const gatewayAlert = gatewayView(gw.deviceGateway).alert
  const waitingText = summary.newDevices && newDevicesText(summary.newDevices)

  const tiles: {
    label: string
    value: string
    sub: string
    color: string
    symbol?: 'off' | 'warn'
    open?: { tab: TabId; title: string }
  }[] = [
    {
      // The device link, not the relay (#69); the stream state rides underneath.
      label: 'Link',
      value: LINK_VALUE[gw.deviceState],
      sub: relaySub,
      color: LINK_COLOR[gw.deviceState] ?? 'var(--muted)',
      open: { tab: 'connection', title: 'Open the Connection tab' }
    },
    {
      label: 'Aircraft',
      value: acft,
      sub: acftSub,
      color: dcs.aircraft.supported ? 'var(--text)' : 'var(--gold)'
    },
    { label: 'DCS Link', value: link, sub: linkSub, color: 'var(--blue)' },
    {
      label: 'Cockpit',
      value: cockpit.value,
      sub: cockpit.sub,
      color: TILE_TONE[cockpit.tone],
      symbol: cockpit.symbol,
      open: { tab: 'cockpit', title: 'Open the Cockpit tab' }
    }
  ]

  const gauges = dcs.telemetry.map((r) => ({
    label: r.label,
    value: Number.isNaN(r.value) ? '—' : Math.round(r.value).toLocaleString(),
    unit: r.unit,
    pct: r.pct,
    color: GAUGE_COLOR[r.tone]
  }))

  const health = [
    {
      label: 'Bytes In',
      value: fmtBytes(dcs.bytesIn),
      color: 'var(--green)',
      accent: 'rgba(110,231,160,0.5)'
    },
    {
      label: 'Bytes Out',
      value: fmtBytes(dcs.bytesOut),
      color: 'var(--blue)',
      accent: 'rgba(30,143,255,0.5)'
    },
    {
      label: 'Frames',
      value: dcs.fps + '/s',
      color: 'var(--text)',
      accent: 'rgba(255,255,255,0.2)'
    },
    {
      label: 'Errors',
      value: String(dcs.errors),
      color: dcs.errors > 0 ? 'var(--red)' : 'var(--text)',
      accent: 'rgba(255,255,255,0.2)'
    },
    {
      label: 'Uptime',
      value: fmtUptime(dcs.uptime),
      color: 'var(--text)',
      accent: 'rgba(255,255,255,0.2)'
    },
    {
      label: 'Reconnects',
      value: String(dcs.reconnects),
      color: 'var(--muted)',
      accent: 'rgba(255,255,255,0.2)'
    }
  ]

  return (
    <div className="ov">
      <div className="hero">
        <img className="hero__logo" src={logo} alt="OPEN SKYHAWK" />
        <div className="hero__txt">
          <div className="hero__tag">Gateway connector &amp; DCS-BIOS / HID monitor</div>
          <div className="hero__sub">Open hardware. Open cockpits.</div>
        </div>
        <div className="hero__tiles">
          {tiles.map((t) => (
            <div
              className={`tile${t.open ? ' tile--link' : ''}`}
              key={t.label}
              {...(t.open && {
                role: 'button',
                tabIndex: 0,
                title: t.open.title,
                onClick: () => nav.set({ tab: t.open!.tab }),
                onKeyDown: (e: React.KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') nav.set({ tab: t.open!.tab })
                }
              })}
            >
              <div className="tile__label">{t.label}</div>
              <div className="tile__value" style={{ color: t.color }}>
                {t.symbol && <Dot state={t.symbol} />}
                {t.value}
              </div>
              <div className="tile__sub">{t.sub}</div>
            </div>
          ))}
        </div>
      </div>

      {gatewayAlert && (
        <div className="err-banner" role="alert">
          <span className="err-banner__sym" aria-hidden="true">
            ✕
          </span>
          <span>
            <b>{gatewayAlert.head}</b> — {gatewayAlert.text}
          </span>
          <button className="ib__link" onClick={() => nav.set({ devicePopOpen: true })}>
            Details
          </button>
        </div>
      )}
      {attention && (
        <div className="warn-banner" role="status">
          ⚠ <b>{attention.head}</b> — {attention.detail}.{' '}
          <button className="wb__link" onClick={() => nav.set({ tab: 'cockpit' })}>
            Open Cockpit
          </button>
        </div>
      )}
      {waitingText && (
        <div className="info-banner" role="status">
          <Dot state="new" />
          <span>
            <b>{waitingText.head}</b> — {waitingText.detail}
          </span>
          {/* Opens the Cockpit with its Adopt dialog showing (#77). */}
          <button className="ib__link" onClick={() => nav.openAdopt()}>
            Open Cockpit →
          </button>
        </div>
      )}

      {!dcs.aircraft.supported && (
        <div className="warn-banner">
          ⚠ <b>{dcs.aircraft.name}</b> loaded — named decode is A-4E-C only. Relaying &amp; stats
          continue; the log shows raw addresses.
        </div>
      )}

      <div className="row-between" style={{ margin: '26px 2px 14px' }}>
        <div className="section-h">Sim Telemetry</div>
        <div className="telemetry-meta">
          CMD <b>{dcs.cmdsPerSec}/s</b> · {dcs.cmdsTotal.toLocaleString()} total · last{' '}
          <span style={{ color: 'var(--muted-4)' }}>{dcs.lastCmd}</span>
        </div>
      </div>
      <div className="gauges">
        {gauges.map((g) => (
          <Gauge key={g.label} {...g} />
        ))}
      </div>

      <div className="section-h" style={{ margin: '26px 2px 14px' }}>
        Stream Health
      </div>
      <div className="health">
        {health.map((h) => (
          <div className="hcard" key={h.label} style={{ borderLeftColor: h.accent }}>
            <div className="hcard__label">{h.label}</div>
            <div className="hcard__value" style={{ color: h.color }}>
              {h.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
