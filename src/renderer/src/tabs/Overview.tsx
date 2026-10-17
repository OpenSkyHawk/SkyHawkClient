import { useMemo } from 'react'
import { fmtBytes, fmtUptime } from '@shared/format'
import { useStore, type TabId } from '../store'
import { isLinkUp, type DeviceState } from '@shared/gateway/ipc'
import { attentionItems, healthBand, nodeViews } from '../cockpit'
import { attentionSummary, cockpitTile, newDevices, newDevicesText } from '../overview'
import { gatewayView } from '../gateway-view'
import { Dot } from './cockpit/Dot'
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

export function Overview() {
  const s = useStore()
  const link = s.transport === 'tcp' ? 'TCP' : s.transport === 'loop' ? 'Multicast' : 'Unicast'
  const linkSub =
    s.transport === 'tcp' ? `${s.host}:${s.port} · remote` : '239.255.50.10:5010 · local'

  const connected = isLinkUp(s.deviceState)
  const acft = s.aircraft.name && s.aircraft.name !== 'NONE' ? s.aircraft.name : 'NONE'
  const acftSub = s.aircraft.inferred ? 'inferred · address range' : '_ACFT_NAME · metadata'

  // The Cockpit's own picture (#63), summed up for the tile and the banners (#65).
  const views = useMemo(
    () => (s.nodeModel ? nodeViews(s.nodeModel, s.nodeTelemetry) : []),
    [s.nodeModel, s.nodeTelemetry]
  )
  const band = useMemo(() => healthBand(views), [views])
  const cockpit = cockpitTile(band, connected)
  const attention = useMemo(
    () =>
      connected && s.attentionBanner
        ? attentionSummary(band, attentionItems(views, s.nodeModel?.outages ?? []))
        : null,
    [connected, s.attentionBanner, band, views, s.nodeModel]
  )
  // Serious Gateway faults only (#94): panel input can't reach DCS. Its own link, so not behind the
  // board-problems setting.
  const gatewayAlert = gatewayView(s.deviceGateway, connected).alert
  const waiting = useMemo(() => newDevices(views, connected), [views, connected])
  const waitingText = waiting && newDevicesText(waiting)

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
      value: LINK_VALUE[s.deviceState],
      sub: connected
        ? s.relaying
          ? 'Gateway · relaying'
          : 'Gateway · stream stopped'
        : s.relaying
          ? 'relay waiting — resumes when it connects'
          : 'stream stopped',
      color: LINK_COLOR[s.deviceState] ?? 'var(--muted)',
      open: { tab: 'connection', title: 'Open the Connection tab' }
    },
    {
      label: 'Aircraft',
      value: acft,
      sub: acftSub,
      color: s.aircraft.supported ? 'var(--text)' : 'var(--gold)'
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

  const gaugeColor = (id: string, pct: number): string => {
    if (id === 'D_FUEL') return pct < 0.25 ? 'var(--red)' : 'var(--gold)'
    return id === 'D_FLAPS_IND' || id === 'ALT_FT' ? 'var(--blue-2)' : 'var(--blue)'
  }
  const gauges = s.telemetry.map((r) => ({
    label: r.label,
    value: Number.isNaN(r.value) ? '—' : Math.round(r.value).toLocaleString(),
    unit: r.unit,
    pct: r.pct,
    color: gaugeColor(r.id, r.pct)
  }))

  const health = [
    {
      label: 'Bytes In',
      value: fmtBytes(s.bytesIn),
      color: 'var(--green)',
      accent: 'rgba(110,231,160,0.5)'
    },
    {
      label: 'Bytes Out',
      value: fmtBytes(s.bytesOut),
      color: 'var(--blue)',
      accent: 'rgba(30,143,255,0.5)'
    },
    { label: 'Frames', value: s.fps + '/s', color: 'var(--text)', accent: 'rgba(255,255,255,0.2)' },
    {
      label: 'Errors',
      value: String(s.errors),
      color: s.errors > 0 ? 'var(--red)' : 'var(--text)',
      accent: 'rgba(255,255,255,0.2)'
    },
    {
      label: 'Uptime',
      value: fmtUptime(s.uptime),
      color: 'var(--text)',
      accent: 'rgba(255,255,255,0.2)'
    },
    {
      label: 'Reconnects',
      value: String(s.reconnects),
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
                onClick: () => s.set({ tab: t.open!.tab }),
                onKeyDown: (e: React.KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') s.set({ tab: t.open!.tab })
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
          <button className="ib__link" onClick={() => s.set({ devicePopOpen: true })}>
            Details
          </button>
        </div>
      )}
      {attention && (
        <div className="warn-banner" role="status">
          ⚠ <b>{attention.head}</b> — {attention.detail}.{' '}
          <button className="wb__link" onClick={() => s.set({ tab: 'cockpit' })}>
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
          <button className="ib__link" onClick={() => s.openAdopt()}>
            Open Cockpit →
          </button>
        </div>
      )}

      {!s.aircraft.supported && (
        <div className="warn-banner">
          ⚠ <b>{s.aircraft.name}</b> loaded — named decode is A-4E-C only. Relaying &amp; stats
          continue; the log shows raw addresses.
        </div>
      )}

      <div className="row-between" style={{ margin: '26px 2px 14px' }}>
        <div className="section-h">Sim Telemetry</div>
        <div className="telemetry-meta">
          CMD <b>{s.cmdsPerSec}/s</b> · {s.cmdsTotal.toLocaleString()} total · last{' '}
          <span style={{ color: 'var(--muted-4)' }}>{s.lastCmd}</span>
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
