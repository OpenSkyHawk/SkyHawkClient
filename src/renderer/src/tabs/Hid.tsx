import { useStore, AXIS_LABELS, HAT_DIRS } from '../store'

function Axis({ label, raw }: { label: string; raw: number }) {
  const pct = Math.max(-1, Math.min(1, raw / 32768)) // signed ±32768
  const fillW = Math.abs(pct) * 50 // % of half-track
  const left = pct >= 0 ? 50 : 50 - fillW
  return (
    <div className="axis">
      <span className="axis__label">{label}</span>
      <div className="axis__bar">
        <span className="axis__mid" />
        <span className="axis__fill" style={{ left: left + '%', width: fillW + '%' }} />
      </div>
      <span className="axis__val">{raw}</span>
    </div>
  )
}

function Hat({ idx, dir }: { idx: number; dir: number }) {
  const active = dir > 0
  return (
    <div className="hat">
      <div className="hat__dial">
        {active && (
          <span className="hat__arrowwrap" style={{ transform: `rotate(${(dir - 1) * 45}deg)` }}>
            <span className="hat__arrow" />
          </span>
        )}
        <span className="hat__center" />
      </div>
      <div className="hat__label">HAT {idx}</div>
      <div className="hat__dir" style={{ color: active ? 'var(--blue)' : 'var(--muted-3)' }}>
        {HAT_DIRS[dir]}
      </div>
    </div>
  )
}

export function Hid() {
  const s = useStore()
  const lit = new Set(s.buttons)

  return (
    <div className="hid">
      <div className="card field">
        <div className="panel-h">
          <span className="section-h">Axes</span>
          <span className="meta">int16 · ±32768</span>
        </div>
        {s.axes.map((v, i) => (
          <Axis key={i} label={AXIS_LABELS[i]!} raw={v} />
        ))}
      </div>

      <div className="card field">
        <div className="panel-h">
          <span className="section-h">Hats</span>
          <span className="meta">8-way POV</span>
        </div>
        <div className="hats">
          {s.hats.map((d, i) => (
            <Hat key={i} idx={i} dir={d} />
          ))}
        </div>
        <div
          className="rate"
          style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--line)' }}
        >
          <span className="card-h">Report Rate</span>
          <span className="rate__num">
            {s.hidRate}
            <small> Hz</small>
          </span>
        </div>
      </div>

      <div className="card field btns">
        <div className="panel-h">
          <span className="section-h">Buttons</span>
          <span className="meta">{lit.size} / 128 pressed</span>
        </div>
        <div className="btns__grid">
          {Array.from({ length: 128 }, (_, i) => (
            <span key={i} className={`btn${lit.has(i) ? ' lit' : ''}`} title={`Button ${i}`}>
              {i}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
