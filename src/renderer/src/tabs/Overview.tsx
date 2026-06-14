import { useStore, fmtBytes, fmtUptime } from '../store'
import logo from '../assets/logo.png'

const C = 289.03 // 2·π·46

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

  const tiles = [
    {
      label: 'Device',
      value: s.relaying ? 'Connected' : 'Idle',
      sub: s.relaying ? 'SimGateway · COM7' : 'awaiting start',
      color: s.relaying ? 'var(--green)' : 'var(--muted)'
    },
    { label: 'Aircraft', value: 'A-4E-C', sub: '_ACFT_NAME · metadata', color: 'var(--text)' },
    { label: 'DCS Link', value: link, sub: linkSub, color: 'var(--blue)' }
  ]

  const gauges = [
    {
      label: 'RPM',
      value: String(Math.round(s.rpm)),
      unit: '% RPM',
      pct: s.rpm / 100,
      color: 'var(--blue)'
    },
    {
      label: 'IAS',
      value: String(Math.round(s.ias)),
      unit: 'KNOTS',
      pct: s.ias / 450,
      color: 'var(--blue)'
    },
    {
      label: 'Flap',
      value: String(Math.round(s.flap)),
      unit: '% DN',
      pct: s.flap / 100,
      color: 'var(--blue-2)'
    },
    {
      label: 'Press Alt',
      value: Math.round(s.alt).toLocaleString(),
      unit: 'FEET',
      pct: s.alt / 40000,
      color: 'var(--blue-2)'
    },
    {
      label: 'Fuel',
      value: String(Math.round(s.fuel)),
      unit: '% QTY',
      pct: s.fuel / 100,
      color: s.fuel < 25 ? 'var(--red)' : 'var(--gold)'
    }
  ]

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
          <div className="hero__tag">SimGateway connector &amp; DCS-BIOS / HID monitor</div>
          <div className="hero__sub">Open hardware. Open cockpits.</div>
        </div>
        <div className="hero__tiles">
          {tiles.map((t) => (
            <div className="tile" key={t.label}>
              <div className="tile__label">{t.label}</div>
              <div className="tile__value" style={{ color: t.color }}>
                {t.value}
              </div>
              <div className="tile__sub">{t.sub}</div>
            </div>
          ))}
        </div>
      </div>

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
