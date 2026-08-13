import { useStore, AXIS_LABELS, HAT_DIRS } from '../store'

/**
 * Per-axis stored-calibration state.
 *
 * `undefined` is a third state, not a synonym for uncalibrated: it means we have not been able
 * to ask the device — no gateway attached, or firmware predating the calibration protocol.
 * Rendering "RAW" in that case would assert something we do not know.
 */
type CalState = 'cal' | 'raw' | undefined

/**
 * The column is always reserved, so values stay aligned whether or not an axis has a badge.
 *
 * An undeclared slot gets an empty cell rather than a RAW badge: RAW means "declared, and the
 * device holds no calibration for it" — something the user can act on. A slot the sketch never
 * declared is not awaiting calibration, and badging it would both overstate the work outstanding
 * and contradict the uncalibrated count in the header.
 */
function CalBadge({ state }: { state: CalState }) {
  if (!state) return <span className="axis__cal" />
  const cal = state === 'cal'
  return (
    <span className="axis__cal">
      <span
        className={`calbadge${cal ? ' calbadge--on' : ''}`}
        title={
          cal
            ? 'Calibrated — endpoints stored on the device'
            : 'Uncalibrated — values pass through untransformed'
        }
      >
        {cal ? 'CAL' : 'RAW'}
      </span>
    </span>
  )
}

function Axis({
  label,
  raw,
  avail,
  cal
}: {
  label: string
  raw: number
  avail: boolean
  cal: CalState
}) {
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
      <CalBadge state={cal} />
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

  // Two different notions of "this axis exists", answering different questions:
  //   availAxes   — what HIDControls.h catalogues, i.e. what the report layout can carry
  //   presentMask — what THIS gateway's sketch actually declares
  //
  // An axis is live only if both are true. A catalogued slot the device never declared reads a
  // constant 0, and rendering that as a value implies a reading that does not exist — so it gets
  // the same dimmed em-dash treatment as an uncatalogued slot. Until the device tells us
  // (no gateway, or firmware predating the protocol) we fall back to the catalogue alone.
  const present = s.cal ? s.cal.axes.filter((a) => a.present) : []
  const uncalibrated = present.filter((a) => !a.calibrated).length
  const axisLive = (i: number) =>
    availAxes.has(i) && (s.cal ? (s.cal.axes[i]?.present ?? false) : true)

  // Calibration is a property of the attached device, so badges follow presentMask alone.
  const calState = (i: number): CalState => {
    const a = s.cal?.axes[i]
    if (!a?.present) return undefined
    return a.calibrated ? 'cal' : 'raw'
  }

  return (
    <div className="hid">
      <div className="card field">
        <div className="panel-h">
          <span className="section-h">Axes</span>
          <span className="meta">
            {s.cal ? `${present.length} of 8 slots · device-reported` : 'int16 · ±32768'}
          </span>
          {s.cal && (
            <span className={`meta ${uncalibrated ? 'meta--warn' : 'meta--ok'}`}>
              {uncalibrated
                ? `${uncalibrated} ${uncalibrated === 1 ? 'axis' : 'axes'} uncalibrated`
                : 'all axes calibrated'}
            </span>
          )}
        </div>
        {s.axes.map((v, i) => (
          <Axis key={i} label={AXIS_LABELS[i]!} raw={v} avail={axisLive(i)} cal={calState(i)} />
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
