import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_CAPTURE_CONFIG,
  hasTravelled,
  holdProgress,
  holdRemainingMs,
  sweepsRemaining
} from '@shared/axis-capture'
import type { CalSnapshot } from '@shared/ipc'
import { CalibrationController, type CalibrationState } from './calibration-controller'
import { AXIS_LABELS, useStore } from './store'

/**
 * Display units: signed ±32767, matching what DCS shows and what the HID tab reads off the
 * report. The wire, storage, capture and COMMIT all stay unsigned 0–65535 — that is the device's
 * language — so this is the single place the two meet.
 *
 * **Display only. Never call this on a value being committed.** The offset applied twice, or
 * zero times, still yields plausible in-range numbers and fails silently.
 */
const toDisplay = (unsigned: number) => unsigned - 32768
const fmt = (n: number) => toDisplay(n).toLocaleString('en-US')
/** A span, not a position — no offset applies. */
const fmtSpan = (n: number) => n.toLocaleString('en-US')
const pct = (v: number) => Math.max(0, Math.min(100, (v / 65535) * 100)).toFixed(2) + '%'

type Point = 'stopA' | 'stopB' | 'centre'

/** Descriptive, never an error: 40% is the expected healthy result for a short-arc axis. */
const TRAVEL_BANDS = [
  { at: 0.6, label: 'Good', tone: 'ok' },
  { at: 0.3, label: 'Workable', tone: '' },
  { at: 0, label: 'Low', tone: 'warn' }
] as const

function travelQuality(min?: number, max?: number) {
  if (min === undefined || max === undefined) return null
  const counts = max - min
  const band = TRAVEL_BANDS.find((b) => counts / 65535 >= b.at)!
  return { counts, pct: Math.round((counts / 65535) * 100), ...band }
}

/**
 * The live prompt during a capture.
 *
 * Two states per step, because they ask for opposite things and reading the wrong one wastes a
 * sweep: **travelling** (gold — keep moving, the bar is not counting yet) and **holding**
 * (green — stop moving, the bar is the dwell timer). The split is `hasTravelled`, not
 * `awaitingMovement`: that flag only rises after a full hold has already elapsed, so it reads
 * false for the first second of every step whether or not the user has touched the axis.
 *
 * Direction words are derived, never assumed. `startRaw` is where the axis sat when capture
 * opened, so "upper" means the raw count went up from there — which stays correct on an
 * inverted axis and on a short-arc axis that never crosses the midpoint. Before the axis has
 * moved at all in the first step there is no evidence either way, so the copy stays neutral.
 */
function prompt(s: CalibrationState, startRaw: number | null) {
  const cap = s.capture
  if (!cap || cap.phase !== 'capturing') return null
  const holding = hasTravelled(cap)
  const dir = (v: number) => (startRaw === null || v >= startRaw ? 'upper' : 'lower')

  if (cap.step === 'centre') {
    return {
      arrow: holding ? '■' : '↓',
      text: holding ? 'Let it settle — hands off' : 'Release the axis and let it return to rest',
      note: holding
        ? 'The axis is settled, so the device has stopped reporting. That is normal — the dwell timer runs on the clock.'
        : 'Take your hand off it completely; a hand resting on the axis is a held position.',
      holding
    }
  }

  // stopA has no direction until the axis moves; stopB is whichever way stopA was not.
  const side =
    cap.step === 'stopA'
      ? s.live && cap.movedBy > 0
        ? dir(s.live.raw)
        : null
      : cap.current.stopA !== undefined
        ? dir(cap.current.stopA) === 'upper'
          ? 'lower'
          : 'upper'
        : null

  if (holding) {
    return {
      arrow: '■',
      text: side ? `HOLD it at the ${side} stop` : 'HOLD it against the stop',
      note: 'The axis is settled, so the device has stopped reporting. That is normal — the dwell timer runs on the clock.',
      holding
    }
  }
  return {
    arrow: side === 'lower' ? '▼' : side === 'upper' ? '▲' : '↕',
    text: !side
      ? 'Sweep the axis all the way to either stop'
      : cap.step === 'stopA'
        ? `Push the axis to its ${side.toUpperCase()} stop`
        : `Now ${side === 'lower' ? 'pull' : 'push'} it to its ${side.toUpperCase()} stop`,
    note: cap.awaitingMovement
      ? 'Nothing has moved yet — take the axis all the way to the mechanical stop.'
      : 'Keep moving steadily until you reach the stop.',
    holding
  }
}

export function CalibrationDialog({
  controller,
  onClose
}: {
  controller: CalibrationController
  onClose: () => void
}) {
  const [s, setS] = useState<CalibrationState>(() => controller.snapshot())
  useEffect(() => controller.subscribe(setS), [controller])

  const present = useMemo(() => s.device?.axes.filter((a) => a.present) ?? [], [s.device])
  const draft = s.drafts[s.axis]
  const stored = s.device?.axes[s.axis]
  const cap = s.capture
  const writing = !!s.write
  const invalid = controller.invalidAxis()
  const shown = draft ?? (stored?.calibrated ? stored : undefined)
  const travel = travelQuality(shown?.min, shown?.max)
  const selfCentring = controller.selfCentring()
  // Where the axis sat when capture opened — the only honest anchor for "upper"/"lower".
  const startRaw = useRef<number | null>(null)
  if (!cap) startRaw.current = null
  else if (startRaw.current === null && s.live) startRaw.current = s.live.raw
  const p = prompt(s, startRaw.current)
  const dirty = controller.dirtyAxes()

  const steps = [
    { n: '1', label: 'Full travel' },
    ...(selfCentring ? [{ n: '2', label: 'Centre' }] : []),
    { n: selfCentring ? '3' : '2', label: 'Review & write' }
  ]
  const stepIndex = !cap
    ? draft
      ? steps.length - 1
      : 0
    : cap.step === 'centre' && selfCentring
      ? 1
      : 0

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
              SimGateway · <span className="cd__ok">connected</span> · signed ±32767
            </div>
          </div>
          <span className="cd__pill">
            <span className="cd__pilldot" />
            <span>DCS link paused</span>
          </span>
          <button className="cd__x" onClick={onClose} disabled={writing}>
            ✕
          </button>
        </header>

        <div className="cd__strip">
          {steps.map((st, i) => (
            <div key={st.n} className="cd__step">
              <span
                className={`cd__stepn${i === stepIndex ? ' is-now' : ''}${
                  i < stepIndex ? ' is-done' : ''
                }`}
              >
                {st.n}
              </span>
              <span className={`cd__steplabel${i === stepIndex ? ' is-now' : ''}`}>{st.label}</span>
            </div>
          ))}
          <span className="cd__hint">
            {cap
              ? `${sweepsRemaining(cap)} sweep${sweepsRemaining(cap) === 1 ? '' : 's'} remaining`
              : selfCentring
                ? 'Three sweeps per axis — one is not enough to find the stops.'
                : 'Three sweeps per axis. No rest position, so centre is the midpoint.'}
          </span>
        </div>

        <div className="cd__body">
          <div className="cd__list">
            {present.map((a) => (
              <button
                key={a.idx}
                className={`cd__axis${a.idx === s.axis ? ' is-on' : ''}`}
                onClick={() => void controller.selectAxis(a.idx)}
                disabled={writing || s.switchingTo !== undefined}
              >
                <span className={`cd__dot${a.calibrated ? ' is-cal' : ''}`} />
                <span className="cd__axisname">{AXIS_LABELS[a.idx]}</span>
                <span className="cd__slot">{a.idx}</span>
                <span className="cd__mark">{s.drafts[a.idx] ? '●' : ''}</span>
                <span className="cd__axisval">
                  {s.switchingTo === a.idx ? '…' : a.calibrated ? 'cal' : 'raw'}
                </span>
              </button>
            ))}
            <div className="cd__note">
              {present.length} of 8 slots · device-reported. Edits are kept when you switch axes and
              written together.
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

            <div className="cd__barhead">
              <span className="cd__label">Captured range</span>
              {cap?.phase === 'capturing' && !cap.awaitingMovement && (
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
                    width: (((shown.max - shown.min) / 65535) * 100).toFixed(2) + '%'
                  }}
                />
              )}
              {shown && <span className="cd__centre" style={{ left: pct(shown.centre) }} />}
              {s.live && <span className="cd__now" style={{ left: pct(s.live.raw) }} />}
            </div>
            <div className="cd__scale">
              <span>−32768</span>
              <span>0</span>
              <span>32767</span>
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
                  onClick={() => controller.setSelfCentring(true)}
                  disabled={writing || cap?.phase === 'capturing'}
                >
                  Self-centring
                </button>
                <button
                  className={`cd__segbtn${!selfCentring ? ' is-on' : ''}`}
                  onClick={() => controller.setSelfCentring(false)}
                  disabled={writing || cap?.phase === 'capturing'}
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
              {cap?.phase === 'rejected' ? (
                <button className="cd__primary" onClick={() => controller.retry()}>
                  Redo that sweep
                </button>
              ) : (
                <button
                  className="cd__primary"
                  onClick={() => controller.startCapture()}
                  disabled={writing || cap?.phase === 'capturing'}
                >
                  {draft || stored?.calibrated ? 'Re-capture travel' : 'Start travel capture'}
                </button>
              )}
              <span className="cd__diag">
                {cap
                  ? `Sweep ${cap.accepted.length + 1} of ${cap.config.sweepsRequired}`
                  : draft
                    ? `${DEFAULT_CAPTURE_CONFIG.sweepsRequired} of ${DEFAULT_CAPTURE_CONFIG.sweepsRequired} sweeps captured`
                    : `${DEFAULT_CAPTURE_CONFIG.sweepsRequired} sweeps per axis`}
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
                          ? `hold ${(holdRemainingMs(cap) / 1000).toFixed(1)} s more`
                          : ''}
                  </span>
                </div>
                <div className="cd__dwellbar">
                  <span style={{ width: (p.holding ? holdProgress(cap) * 100 : 0) + '%' }} />
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

            {cap && cap.accepted.length > 0 && (
              <div className="cd__conv">
                <div className="cd__label">Sweep convergence</div>
                {cap.accepted.map((w, i) => {
                  // Accepted sweeps are within slack by construction, so this flags the ones that
                  // still contribute nothing under widest-wins rather than reporting a fault.
                  const widest = Math.max(...cap.accepted.map((a) => a.max - a.min))
                  const short = widest - (w.max - w.min) > widest * cap.config.shortfallFraction
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
          <div className="cd__save">
            <div className="cd__saverow">
              <span className="cd__spin" />
              <span className="cd__savetext">
                {s.write.phase === 'writing'
                  ? `Writing ${AXIS_LABELS[s.write.queue[s.write.at]!]} to the device…`
                  : `Reading ${AXIS_LABELS[s.write.queue[s.write.at]!]} back from the device…`}
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
          {invalid && !writing && (
            <span className="cd__invalid">
              {AXIS_LABELS[invalid.axis]}: {invalid.reason}
            </span>
          )}
          <div className="cd__spacer" />
          {stored?.calibrated && !writing && (
            <button className="cd__ghost" onClick={() => void controller.deleteAxis(s.axis)}>
              Delete calibration
            </button>
          )}
          <button className="cd__ghost" onClick={onClose} disabled={writing}>
            Cancel
          </button>
          <button
            className="cd__primary cd__primary--sm"
            onClick={() => void controller.save()}
            disabled={writing || !dirty.length || !!invalid}
          >
            {writing ? 'Writing…' : dirty.length ? `Write ${dirty.length} axis` : 'Write'}
          </button>
        </footer>
      </div>
    </div>
  )
}

/** Owns the controller's lifetime and feeds it the RAW stream. */
export function useCalibration(device?: CalSnapshot) {
  const api = window.skyhawk
  const ref = useRef<CalibrationController | null>(null)
  if (!ref.current && api) ref.current = new CalibrationController(api)
  const controller = ref.current
  const [open, setOpen] = useState(false)
  const setCal = useStore((st) => st.set)

  useEffect(() => {
    if (!controller || !api) return
    const off = api.on('cal:raw', (batch) => controller.ingest(batch))
    return () => {
      off()
      controller.dispose()
    }
  }, [controller, api])

  useEffect(() => controller?.deviceChanged(device), [controller, device])

  return {
    controller,
    open,
    async start(axis: number) {
      if (!controller) return
      await controller.open(axis, device)
      setOpen(true)
    },
    async close() {
      if (!controller) return
      await controller.close()
      setOpen(false)
      const r = await window.skyhawk?.calRead()
      if (r?.ok) setCal({ cal: r.value })
    }
  }
}
