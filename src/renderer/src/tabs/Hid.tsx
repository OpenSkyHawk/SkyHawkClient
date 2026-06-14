import { useStore, AXIS_LABELS, HAT_DIRS } from '../store'

function Axis({ label, raw, avail }: { label: string; raw: number; avail: boolean }) {
  const pct = Math.max(-1, Math.min(1, raw / 32768)) // signed ±32768
  const fillW = Math.abs(pct) * 50 // % of half-track
  const left = pct >= 0 ? 50 : 50 - fillW
  return (
    <div className={`axis${avail ? '' : ' hid--off'}`}>
      <span className="axis__label">{label}</span>
      <div className="axis__bar">
        <span className="axis__mid" />
        {avail && <span className="axis__fill" style={{ left: left + '%', width: fillW + '%' }} />}
      </div>
      <span className="axis__val">{avail ? raw : '—'}</span>
    </div>
  )
}

function Hat({ idx, dir, avail }: { idx: number; dir: number; avail: boolean }) {
  const active = avail && dir > 0
  return (
    <div className={`hat${avail ? '' : ' hid--off'}`}>
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
        {avail ? HAT_DIRS[dir] : 'n/a'}
      </div>
    </div>
  )
}

export function Hid() {
  const s = useStore()
  const lit = new Set(s.buttons)
  const availAxes = new Set(s.availAxes)
  const availHats = new Set(s.availHats)
  const availButtons = new Set(s.availButtons)

  return (
    <div className="hid">
      <div className="card field">
        <div className="panel-h">
          <span className="section-h">Axes</span>
          <span className="meta">int16 · ±32768</span>
        </div>
        {s.axes.map((v, i) => (
          <Axis key={i} label={AXIS_LABELS[i]!} raw={v} avail={availAxes.has(i)} />
        ))}
      </div>

      <div className="card field">
        <div className="panel-h">
          <span className="section-h">Hats</span>
          <span className="meta">8-way POV</span>
        </div>
        <div className="hats">
          {s.hats.map((d, i) => (
            <Hat key={i} idx={i} dir={d} avail={availHats.has(i)} />
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
          <span className="meta">
            {lit.size} pressed · {availButtons.size} mapped
          </span>
        </div>
        <div className="btns__grid">
          {Array.from({ length: 128 }, (_, i) => {
            const cls = lit.has(i) ? ' lit' : availButtons.has(i) ? '' : ' btn--off'
            return (
              <span key={i} className={`btn${cls}`} title={`Button ${i}`}>
                {i}
              </span>
            )
          })}
        </div>
      </div>
    </div>
  )
}
