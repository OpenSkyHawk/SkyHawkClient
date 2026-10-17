import { useEffect, useRef, useState } from 'react'
import { CAL_PROTO, HID_REPORT_LAYOUT } from '@shared/firmware'
import type { CalibrationDialogState } from '@shared/hid/calibration'
import { AXIS_OFFSET, AXIS_SPAN, fmt, fmtSpan, pct, promptText } from './calibration-view'
import { AXIS_LABELS, type CalibrationIntents } from './store'

type Point = 'stopA' | 'stopB' | 'centre'

/**
 * The axis calibration dialog. Main runs the workflow and decides everything shown here (`d`, the
 * pushed CalibrationDialogState); the dialog draws it, words it, and sends the user's actions.
 */
export function CalibrationDialog({
  d,
  calibrate
}: {
  d: CalibrationDialogState
  calibrate: CalibrationIntents
}) {
  const s = d.workflow
  const { present, writing, invalid, shown, travel, selfCentring, dirty } = d
  const cap = s.capture
  const p = d.prompt && promptText(d.prompt)
  const onClose = () => calibrate.close()

  // Centre is not a stage the user navigates to — it is captured inside the same sweep as the
  // stops, and naming it as step 2 promised a separate thing to do that never arrives.
  const steps = ['Full travel', 'Review & write']
  const stepIndex = d.stepIndex

  /**
   * Delete is armed by the first click and performed by the second.
   *
   * RESET writes flash the moment it is sent, and nothing on this side holds a copy yet, so a
   * stray click costs three sweeps of work with no way back. Disarms itself after a few seconds
   * and whenever the axis changes, so an armed button can never be inherited by a different
   * axis than the one the user was looking at.
   */
  const [armed, setArmed] = useState(false)
  useEffect(() => setArmed(false), [s.axis, s.paused])
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])

  /** A held "Captured" beat, so each point lands visibly before the prompt moves on. */
  const [beat, setBeat] = useState<{ p: Point; v: number } | null>(null)
  const prev = useRef<Partial<Record<Point, number>>>({})
  useEffect(() => {
    const now = (cap?.current ?? {}) as Partial<Record<Point, number>>
    for (const k of ['stopA', 'stopB', 'centre'] as Point[]) {
      if (now[k] !== undefined && prev.current[k] === undefined) setBeat({ p: k, v: now[k]! })
    }
    prev.current = cap ? { ...now } : {}
  }, [cap])
  useEffect(() => {
    if (!beat) return
    const t = setTimeout(() => setBeat(null), 1200)
    return () => clearTimeout(t)
  }, [beat])

  return (
    <div className="cd">
      <div className="cd__sheet">
        <header className="cd__head">
          <span className="cd__icon">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#1e8fff"
              strokeWidth="1.8"
            >
              <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
            </svg>
          </span>
          <div className="cd__title">
            <div className="cd__h1">Axis Calibration · {AXIS_LABELS[s.axis]}</div>
            <div className="cd__h2">
              Gateway ·{' '}
              {s.paused ? (
                <span className="cd__off">serial link closed</span>
              ) : (
                <span className="cd__ok">connected</span>
              )}{' '}
              {`· signed ±${HID_REPORT_LAYOUT.axes.max}`}
            </div>
          </div>
          <span className="cd__pill">
            <span className="cd__pilldot" />
            <span>DCS link paused</span>
          </span>
          <button className="cd__x" onClick={onClose} disabled={d.disabled.close}>
            ✕
          </button>
        </header>

        {d.strip && (
          <div className="cd__strip">
            {steps.map((label, i) => (
              <div key={label} className="cd__step">
                <span
                  className={`cd__stepn${i === stepIndex ? ' is-now' : ''}${
                    i < stepIndex ? ' is-done' : ''
                  }`}
                >
                  {i + 1}
                </span>
                <span className={`cd__steplabel${i === stepIndex ? ' is-now' : ''}`}>{label}</span>
              </div>
            ))}
            <span className="cd__hint">
              {d.sweepsRemaining !== undefined
                ? `${d.sweepsRemaining} sweep${d.sweepsRemaining === 1 ? '' : 's'} remaining`
                : 'Captured, not written — nothing reaches the device until you write.'}
            </span>
          </div>
        )}

        <div className="cd__body">
          <div className="cd__list">
            {present.map((a) => (
              <button
                key={a.idx}
                className={`cd__axis${a.idx === s.axis ? ' is-on' : ''}`}
                onClick={() => calibrate.selectAxis(a.idx)}
                disabled={d.disabled.axisSwitch}
              >
                <span className="cd__axisname">{AXIS_LABELS[a.idx]}</span>
                <span className="cd__slot">Axis {a.idx}</span>
                {/* The dot marks unwritten work; the badge reports what the device holds. Two
                    marks rather than one, because they answer different questions — an EDIT
                    badge replacing CAL/RAW hid the stored state behind the pending one. */}
                <span className="cd__mark" title="Captured, not yet written">
                  {s.drafts[a.idx] ? '●' : ''}
                </span>
                {s.switchingTo === a.idx ? (
                  <span className="cd__axisval">…</span>
                ) : (
                  <span className={`calbadge${a.calibrated ? ' calbadge--on' : ''}`}>
                    {a.calibrated ? 'CAL' : 'RAW'}
                  </span>
                )}
              </button>
            ))}
            <div className="cd__note">
              {present.length} of {CAL_PROTO.axisSlots} slots · device-reported. Edits are kept when
              you switch axes and written together.
            </div>
          </div>

          <div className="cd__detail">
            <div className="cd__readouts">
              <div>
                <div className="cd__label">Raw input</div>
                <div className="cd__big">{s.live ? fmt(s.live.raw) : '—'}</div>
              </div>
              <div className="cd__vrule" />
              <div>
                <div className="cd__label">
                  To DCS <span className="cd__dim">· through stored calibration</span>
                </div>
                <div className="cd__big cd__big--blue">{s.live ? fmt(s.live.cal) : '—'}</div>
              </div>
              <div className="cd__travel">
                <div className="cd__label">Recorded travel</div>
                <div className="cd__travelrow">
                  <span className={`cd__tq cd__tq--${travel?.tone ?? ''}`}>
                    {travel ? `${travel.pct}%` : '—'}
                  </span>
                  <span className="cd__travelcounts">
                    {travel ? `${fmtSpan(travel.counts)} counts` : ''}
                  </span>
                  <span className={`cd__tqlabel cd__tq--${travel?.tone ?? ''}`}>
                    {travel?.label ?? ''}
                  </span>
                </div>
              </div>
            </div>

            {/* Named as sensor-space on purpose. Everything from here down — the bar, the live
                marker and the three cards — is where the axis physically sits, not what the sim
                receives: `centre` maps to 0 signed by construction, so the card reading +282 and
                DCS reading 0 are the same position in two different spaces. */}
            <div className="cd__barhead">
              <span className="cd__label">
                Captured range <span className="cd__dim">· sensor</span>
              </span>
              {d.holdAtStops && (
                <span className="cd__holding">
                  <span className="cd__holddot" />
                  Hold at each stop
                </span>
              )}
            </div>
            <div className="cd__bar">
              {shown && (
                <span
                  className="cd__band"
                  style={{
                    left: pct(shown.min),
                    width: (((shown.max - shown.min) / AXIS_SPAN) * 100).toFixed(2) + '%'
                  }}
                />
              )}
              {shown && <span className="cd__centre" style={{ left: pct(shown.centre) }} />}
              {s.live && <span className="cd__now" style={{ left: pct(s.live.raw) }} />}
            </div>
            <div className="cd__scale">
              <span>−{AXIS_OFFSET}</span>
              <span>0</span>
              <span>{HID_REPORT_LAYOUT.axes.max}</span>
            </div>

            <div className="cd__cards">
              {(['min', 'centre', 'max'] as const).map((k) => (
                <div key={k} className="cd__card">
                  <div className="cd__label cd__label--sm">{k === 'centre' ? 'Center' : k}</div>
                  <div className="cd__cardval">{shown ? fmt(shown[k]) : '—'}</div>
                </div>
              ))}
            </div>

            <div className="cd__warn">
              <span className="cd__warnicon">⚠</span>
              <span>
                The joystick stays live to DCS throughout — sweeping this axis will move whatever it
                is bound to in the sim. Pause the mission or unbind the axis before capturing.
              </span>
            </div>

            <div className="cd__rest">
              <span className="cd__label">Rest position</span>
              <div className="cd__seg">
                <button
                  className={`cd__segbtn${selfCentring ? ' is-on' : ''}`}
                  onClick={() => calibrate.setSelfCentring(true)}
                  disabled={d.disabled.rest}
                >
                  Self-centring
                </button>
                <button
                  className={`cd__segbtn${!selfCentring ? ' is-on' : ''}`}
                  onClick={() => calibrate.setSelfCentring(false)}
                  disabled={d.disabled.rest}
                >
                  None
                </button>
              </div>
              <span className="cd__restnote">
                {selfCentring
                  ? 'Returns to a rest position — centre is captured, not assumed.'
                  : 'No rest position — centre is the midpoint of the captured travel.'}
              </span>
            </div>

            <div className="cd__actions">
              {d.capture.action === 'redo' ? (
                <button
                  className="cd__primary"
                  onClick={() => calibrate.retry()}
                  disabled={d.capture.disabled}
                >
                  Redo that sweep
                </button>
              ) : (
                <button
                  className="cd__primary"
                  onClick={() => calibrate.startCapture()}
                  disabled={d.capture.disabled}
                >
                  {d.capture.recapture ? 'Re-capture travel' : 'Start travel capture'}
                </button>
              )}
              <span className="cd__diag">
                {d.sweeps.kind === 'capturing'
                  ? `Sweep ${d.sweeps.sweep} of ${d.sweeps.of}`
                  : d.sweeps.kind === 'captured'
                    ? `${d.sweeps.of} of ${d.sweeps.of} sweeps captured`
                    : `${d.sweeps.of} sweeps per axis`}
              </span>
            </div>

            {!!cap?.interruptions && (
              <div className="cd__spikes">{cap.interruptions} spikes rejected</div>
            )}

            {p && cap && (
              <div className={`cd__dwell${p.holding || beat ? ' is-hold' : ''}`}>
                <div className="cd__dwellrow">
                  <span className="cd__arrow">{beat ? '✓' : p.arrow}</span>
                  <span className="cd__prompt">{beat ? `Captured ${fmt(beat.v)}` : p.text}</span>
                  <span className="cd__dwelltime">
                    {beat
                      ? ''
                      : cap.awaitingConfirmation
                        ? 'waiting for a sample'
                        : p.holding
                          ? `hold ${(d.hold!.remainingMs / 1000).toFixed(1)} s more`
                          : ''}
                  </span>
                </div>
                <div className="cd__dwellbar">
                  <span style={{ width: (p.holding ? d.hold!.progress * 100 : 0) + '%' }} />
                </div>
                <div className="cd__dwellnote">
                  {cap.awaitingConfirmation
                    ? 'Held long enough, waiting for the axis to report again — a settled axis emits only on change.'
                    : p.note}
                </div>
              </div>
            )}

            {cap?.phase === 'rejected' && (
              <div className="cd__short">
                <span className="cd__shortbar" />
                <span>{cap.rejection}</span>
              </div>
            )}

            {d.convergence.length > 0 && (
              <div className="cd__conv">
                <div className="cd__label">Sweep convergence</div>
                {d.convergence.map((w, i) => {
                  const short = w.short
                  return (
                    <div key={i} className="cd__convrow">
                      <span className="cd__convn">Sweep {i + 1}</span>
                      <span className="cd__convrange">
                        {fmt(w.min)} … {fmt(w.max)}
                      </span>
                      <span className="cd__convspan">{fmtSpan(w.max - w.min)} counts</span>
                      <span className={`cd__convnote${short ? ' is-short' : ''}`}>
                        {short ? 'short of widest' : i > 0 ? 'settled' : ''}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}

            <div className="cd__foot">
              The device applies a two-segment map so centre lands exactly on 0 signed, plus a
              128-count output hysteresis — so no deadzone setting is needed. Curves and inversion
              are left to DCS.
            </div>
          </div>
        </div>

        {s.write && (
          <div className={`cd__save${s.write.phase === 'done' ? ' is-done' : ''}`}>
            <div className="cd__saverow">
              {s.write.phase === 'done' ? (
                <span className="cd__tick">✓</span>
              ) : (
                <span className="cd__spin" />
              )}
              <span className="cd__savetext">
                {s.write.phase === 'writing'
                  ? `Writing ${AXIS_LABELS[s.write.queue[s.write.at]!]} to the device…`
                  : s.write.phase === 'verifying'
                    ? `Reading ${AXIS_LABELS[s.write.queue[s.write.at]!]} back from the device…`
                    : `Stored on the device — read back and confirmed.`}
              </span>
              <span className="cd__savecount">
                {s.write.at + 1} of {s.write.queue.length}
              </span>
            </div>
            <div className="cd__chips">
              {s.write.queue.map((idx) => (
                <span key={idx} className="cd__chip">
                  <span className="cd__chipname">{AXIS_LABELS[idx]}</span>
                  <span className={`cd__chiptag${s.write!.stored.includes(idx) ? ' is-done' : ''}`}>
                    {s.write!.stored.includes(idx) ? 'stored' : 'queued'}
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}

        {d.restore === 'panel' && s.restorable && (
          <div className="cd__restore">
            <div className="cd__restorehead">
              <span className="cd__restoretitle">Restore calibration to the device</span>
              <span className="cd__restorewhen">
                {s.restorable.board.confirmedAt
                  ? `confirmed ${new Date(s.restorable.board.confirmedAt).toLocaleString()}`
                  : 'confirmation time unknown'}
              </span>
            </div>
            <div className="cd__restorerows">
              {s.restorable.axes.map((idx) => {
                const a = s.restorable!.board.axes[idx]!
                return (
                  <div key={idx} className="cd__restorerow">
                    <span className="cd__restorename">{AXIS_LABELS[idx]}</span>
                    <span className="cd__restorevals">
                      {fmt(a.min)} … {fmt(a.centre)} … {fmt(a.max)}
                    </span>
                    <span className="cd__restorestate">
                      {a.selfCentring ? 'centre measured' : 'centre from midpoint'}
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="cd__restorefoot">
              <span className="cd__restorenote">
                min / centre / max per axis, for board{' '}
                <code>{s.device?.serialNumber ?? 'unknown'}</code>. Only axes the device has lost
                are written; anything it still holds is left alone.
              </span>
              <button className="cd__ghost" onClick={() => calibrate.setRestoreOpen(false)}>
                Not now
              </button>
              <button className="cd__primary cd__primary--sm" onClick={() => calibrate.restore()}>
                Restore {s.restorable.axes.length}{' '}
                {s.restorable.axes.length === 1 ? 'axis' : 'axes'}
              </button>
            </div>
          </div>
        )}

        {d.restore === 'reoffer' && s.restorable && (
          <button className="cd__reoffer" onClick={() => calibrate.setRestoreOpen(true)}>
            <span className="cd__reofferdot" />
            {s.restorable.axes.length} {s.restorable.axes.length === 1 ? 'axis has' : 'axes have'} a
            saved copy this device no longer holds — review
          </button>
        )}

        {d.notice && s.notice && (
          <div className={`cd__notice${s.notice.kind === 'erased' ? ' is-erased' : ''}`}>
            <span className="cd__noticeicon">{s.notice.kind === 'written' ? '✓' : '⌫'}</span>
            <span>
              {s.notice.axes.map((i) => AXIS_LABELS[i]).join(', ')}
              {s.notice.kind === 'written'
                ? ` written to the device and read back. ${
                    s.notice.axes.length === 1 ? 'The axis now reports' : 'They now report'
                  } through this calibration.`
                : ' calibration erased. The axis now passes through untransformed.'}
            </span>
          </div>
        )}

        {s.paused && (
          <div className="cd__err">
            <span className="cd__errbar" />
            <div>
              <b>Serial link closed</b> — calibration is paused; nothing more reaches the device.
              Connect on the Connection tab to continue (captured sweeps are kept).
            </div>
          </div>
        )}

        {s.failure && (
          <div className="cd__err">
            <span className="cd__errbar" />
            <div>
              <b>{s.failure.kind === 'timeout' ? 'No acknowledgement' : 'The device refused'}</b>{' '}
              {s.failure.message}
              {s.storedBeforeFailure?.length ? (
                <>
                  {' '}
                  Stored before stopping:{' '}
                  {s.storedBeforeFailure.map((i) => AXIS_LABELS[i]).join(', ')}.
                </>
              ) : null}
            </div>
          </div>
        )}

        <footer className="cd__bar2">
          {d.showInvalid && invalid && (
            <span className="cd__invalid">
              {AXIS_LABELS[invalid.axis]}: {invalid.reason}
            </span>
          )}
          <div className="cd__spacer" />
          {d.remove.shown && (
            <button
              className={`cd__ghost${armed ? ' cd__ghost--danger' : ''}`}
              disabled={d.remove.disabled}
              onClick={() => {
                if (!armed) {
                  setArmed(true)
                  return
                }
                setArmed(false)
                calibrate.deleteAxis(s.axis)
              }}
            >
              {armed ? `Erase ${AXIS_LABELS[s.axis]} from the device?` : 'Delete calibration'}
            </button>
          )}
          <button className="cd__ghost" onClick={onClose} disabled={d.disabled.close}>
            Cancel
          </button>
          <button
            className="cd__primary cd__primary--sm"
            onClick={() => calibrate.save()}
            disabled={d.disabled.write}
          >
            {writing ? 'Writing…' : dirty.length ? `Write ${dirty.length} axis` : 'Write'}
          </button>
        </footer>
      </div>
    </div>
  )
}
