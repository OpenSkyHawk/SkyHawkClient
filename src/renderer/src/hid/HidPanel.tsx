import type { ReactNode } from 'react'
import { HID_REPORT_LAYOUT } from '@shared/firmware'
import type { CalBadge, CalibrationState } from '@shared/hid/calibration'
import { useNav } from '../app/kit'
import { useGatewayStore } from '../gateway'
import { useHidStore } from './store'
import { AXIS_LABELS, freshnessView, HAT_DIRS } from './hid-view'

/**
 * Per-axis stored-calibration state, as main reports it.
 *
 * `undefined` is a third state, not a synonym for uncalibrated: it means we have not been able
 * to ask the device — no gateway attached, or firmware predating the calibration protocol.
 * Rendering "RAW" in that case would assert something we do not know.
 */
type CalState = CalBadge | undefined

/**
 * The column is always reserved, so values stay aligned whether or not an axis has a badge.
 *
 * An undeclared slot gets an empty cell rather than a RAW badge: RAW means "declared, and the
 * device holds no calibration for it" — something the user can act on. A slot the sketch never
 * declared is not awaiting calibration, and badging it would both overstate the work outstanding
 * and contradict the uncalibrated count in the header.
 */
function CalBadge({ state, onClick }: { state: CalState; onClick?: () => void }) {
  if (!state) return <span className="axis__cal" />
  const cal = state === 'cal'
  return (
    <span className="axis__cal">
      <button
        className={`calbadge${cal ? ' calbadge--on' : ''}`}
        onClick={onClick}
        disabled={!onClick}
        title={
          onClick
            ? 'Calibrate this axis'
            : cal
              ? 'Calibrated — endpoints stored on the device'
              : 'Uncalibrated — values pass through untransformed'
        }
      >
        {cal ? 'CAL' : 'RAW'}
      </button>
    </span>
  )
}

function Axis({
  label,
  raw,
  avail,
  cal,
  onCalibrate
}: {
  label: string
  raw: number
  avail: boolean
  cal: CalState
  onCalibrate?: () => void
}) {
  const pct = Math.max(-1, Math.min(1, raw / -HID_REPORT_LAYOUT.axes.min)) // signed ±32768
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
      <CalBadge state={cal} onClick={onCalibrate} />
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

/**
 * The HID tab's live view: axes, hats, buttons and the report rate. Axis calibration is the
 * calibration topic's (hid never imports it): the HID tab hands in its state, its dialog and the
 * open intent (app/hid/HidTab.tsx).
 */
export function HidPanel({
  dialog,
  cal,
  onCalibrate
}: {
  /** The calibration dialog while it is open. */
  dialog?: ReactNode
  /** The HID tab's calibration state as main pushes it (`cal:workflow`). */
  cal: CalibrationState['tab']
  /** Open the calibration dialog on `axis`; `review` expands the restore offer. */
  onCalibrate: (axis: number, review?: boolean) => void
}) {
  const s = useHidStore()
  const set = useNav((x) => x.set)
  // The joystick is read alongside DCS and never needs the serial link; calibration does (#74).
  // So the live view below ignores the link, and only calibration is gated on it.
  const linkUp = useGatewayStore((x) => x.linkUp)
  const boardPresent = useGatewayStore((x) => x.boardPresent)
  const lit = new Set(s.buttons)
  const availHats = new Set(s.availHats)
  const availButtons = new Set(s.availButtons)
  const fresh = freshnessView(boardPresent, s.hidBand)

  // Which axis slots are live — catalogued and declared by this Gateway — is main's (hid:report,
  // R3.3: main/hid/hid-facts.ts), as is how many it declares.
  const snap = cal.snapshot
  const uncalibrated = cal.uncalibrated
  const axisLive = (i: number) => s.axisLive[i] ?? false

  // Calibration is a property of the attached device, so badges follow presentMask alone.
  const calState = (i: number): CalState => cal.badges[i]

  return (
    <div className="hid">
      {dialog}
      {cal.showOffer && cal.offer && (
        <div className="calrestore">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#5cb0ff"
            strokeWidth="1.8"
          >
            <path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />
          </svg>
          <span className="calrestore__txt">
            {cal.offer.axes.length === 1
              ? `${AXIS_LABELS[cal.offer.axes[0]!]} has no calibration on the device`
              : `${cal.offer.axes.length} axes have no calibration on the device`}
            , but this client holds a copy the device confirmed
            {cal.offer.confirmedAt ? ` on ${new Date(cal.offer.confirmedAt).toLocaleString()}` : ''}
            .
          </span>
          <button className="calbtn" onClick={() => onCalibrate(cal.offerAxis!, true)}>
            Review &amp; restore…
          </button>
        </div>
      )}
      <div className="card field">
        <div className="panel-h">
          <span className="section-h">Axes</span>
          <span className="meta">
            {snap
              ? `${s.hidPresent} of ${HID_REPORT_LAYOUT.axes.count} slots · device-reported`
              : `int16 · ±${-HID_REPORT_LAYOUT.axes.min}`}
          </span>
          {snap && (
            <span className={`meta ${uncalibrated ? 'meta--warn' : 'meta--ok'}`}>
              {uncalibrated
                ? `${uncalibrated} ${uncalibrated === 1 ? 'axis' : 'axes'} uncalibrated`
                : 'all axes calibrated'}
            </span>
          )}
          {cal.calibrate.shown && (
            <button
              className="calbtn"
              disabled={!cal.calibrate.enabled}
              title={
                cal.calibrate.enabled
                  ? 'Calibrate an axis'
                  : 'Calibration needs the serial link — Connect on the Connection tab'
              }
              onClick={() => onCalibrate(cal.calibrate.axis!)}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#5cb0ff"
                strokeWidth="2"
              >
                <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
              </svg>
              Calibrate
            </button>
          )}
        </div>
        {!linkUp && (
          <div className="devnote hid__calnote">
            Live axes, hats and buttons keep working — they come from the joystick, which never
            needs the serial link. <b>Calibration needs the serial link</b>:{' '}
            <button className="devnote__link" onClick={() => set({ tab: 'connection' })}>
              Connect on the Connection tab
            </button>
            .
          </div>
        )}
        {s.axes.map((v, i) => (
          <Axis
            key={i}
            label={AXIS_LABELS[i]!}
            raw={v}
            avail={axisLive(i)}
            cal={calState(i)}
            onCalibrate={calState(i) ? () => onCalibrate(i) : undefined}
          />
        ))}
      </div>

      <div className="hid__col">
        <div className="card field hid__hats">
          <div className="panel-h">
            <span className="section-h">Hats</span>
            <span className="meta">{HID_REPORT_LAYOUT.hats.directions}-way POV</span>
          </div>
          <div className="hats">
            {s.hats.map((d, i) => (
              <Hat key={i} idx={i} dir={d} avail={availHats.has(i)} />
            ))}
          </div>
        </div>

        <div className="card rate">
          <span className="section-h">Reports</span>
          <span className="rate__state">
            <span className={`rate__dot ${fresh.cls}`} />
            <span className={`rate__label ${fresh.cls}`}>{fresh.label}</span>
            <span className="rate__rule" />
            <span className="rate__num">
              {s.hidRate}
              <small> Hz</small>
            </span>
          </span>
        </div>
      </div>

      <div className="card field btns">
        <div className="panel-h">
          <span className="section-h">Buttons</span>
          <span className="meta">
            {HID_REPORT_LAYOUT.buttons.count} × 1-bit · {availButtons.size} mapped ·{' '}
            <span className="meta--lit">{lit.size} lit</span>
          </span>
        </div>
        <div className="btns__grid">
          {Array.from({ length: HID_REPORT_LAYOUT.buttons.count }, (_, i) => {
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
