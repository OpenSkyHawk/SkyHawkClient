import { useEffect, useMemo, useRef, useState } from 'react'
import { holdProgress, sweepsRemaining } from '@shared/axis-capture'
import type { CalSnapshot } from '@shared/ipc'
import { CalibrationController, type CalibrationState } from './calibration-controller'
import { AXIS_LABELS, useStore } from './store'

/**
 * Display units: signed ±32767, matching what DCS shows and what the HID tab reads off the
 * report. The wire, storage, capture and COMMIT all stay unsigned 0–65535 — that is the device's
 * language — so this is the single place the two meet.
 *
 * **Display only. Never call this on a value being committed.** The offset applied twice, or
 * zero times, still yields plausible in-range numbers and fails silently, which is why the
 * conversion lives in exactly one function used at exactly one layer.
 */
const toDisplay = (unsigned: number) => unsigned - 32768

/** Format an unsigned device value in the signed units the user recognises. */
const fmt = (n: number) => toDisplay(n).toLocaleString('en-US')

/** Format a raw count difference — a span, so no offset applies. */
const fmtSpan = (n: number) => n.toLocaleString('en-US')

type Point = 'stopA' | 'stopB' | 'centre'

const POINT_LABEL: Record<Point, string> = {
  stopA: 'First stop',
  stopB: 'Second stop',
  centre: 'Rest position'
}

/** What to tell the user to do right now. Derived from the capture, never from a step counter. */
function instruction(s: CalibrationState): { title: string; detail: string } {
  const cap = s.capture
  if (!cap) {
    return {
      title: 'Ready to capture',
      detail: 'Three sweeps. Each one records both stops, then where the axis rests.'
    }
  }
  if (cap.phase === 'rejected') {
    return { title: 'That sweep fell short', detail: cap.rejection ?? '' }
  }
  if (cap.phase === 'complete') {
    return { title: 'All three sweeps captured', detail: 'Review the values, then write them.' }
  }
  // The axis has not gone anywhere yet, so a progress bar would fill and commit nothing. Say
  // what is actually being waited for.
  if (cap.awaitingMovement) {
    return cap.step === 'centre'
      ? { title: 'Let it return to rest', detail: 'Release the axis and take your hand off it.' }
      : {
          title: cap.step === 'stopA' ? 'Sweep to one stop' : 'Now to the other stop',
          detail: 'Waiting for the axis to move — go all the way to the mechanical stop.'
        }
  }
  const holding = cap.ref !== null && holdProgress(cap) > 0
  if (cap.step === 'centre') {
    return {
      title: 'Let it return to rest',
      detail: holding ? 'Settling — leave it alone.' : 'Release the axis and take your hand off.'
    }
  }
  return {
    title: cap.step === 'stopA' ? 'Sweep all the way to one stop' : 'Now all the way to the other',
    detail: holding
      ? 'Hold it against the stop.'
      : 'Reach the mechanical stop, then hold still there.'
  }
}

/**
 * The whole sequence, always visible.
 *
 * Showing only the current instruction made the flow feel like it skipped: a point was captured
 * and the text changed in the same frame, with no way to know what had just happened or what was
 * coming. The checklist answers both without the user having to infer them.
 */
function Steps({
  order,
  current,
  captured,
  progress,
  justCaptured
}: {
  order: Point[]
  current?: Point
  captured: Partial<Record<Point, number>>
  progress: number
  justCaptured?: Point
}) {
  return (
    <ol className="calsteps">
      {order.map((p) => {
        const done = captured[p] !== undefined
        const isNow = p === current
        return (
          <li
            key={p}
            className={`calsteps__row${isNow ? ' is-now' : ''}${done ? ' is-done' : ''}${
              justCaptured === p ? ' is-flash' : ''
            }`}
          >
            <span className="calsteps__mark">{done ? '✓' : isNow ? '›' : ''}</span>
            <span className="calsteps__label">{POINT_LABEL[p]}</span>
            <span className="calsteps__val mono">{done ? fmt(captured[p]!) : ''}</span>
            {isNow && !done && (
              <span className="calsteps__prog">
                <span style={{ width: progress * 100 + '%' }} />
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function RangeBar({
  value,
  min,
  centre,
  max
}: {
  value?: number
  min?: number
  centre?: number
  max?: number
}) {
  const pct = (v: number) => Math.max(0, Math.min(100, (v / 65535) * 100))
  const captured = min !== undefined && max !== undefined
  return (
    <div>
      <div className="calnum__label">Captured range</div>
      <div className="calbar">
        {captured && (
          <span
            className="calbar__band"
            style={{ left: pct(min) + '%', width: pct(max) - pct(min) + '%' }}
          />
        )}
        {centre !== undefined && (
          <span className="calbar__centre" style={{ left: pct(centre) + '%' }} />
        )}
        {value !== undefined && <span className="calbar__now" style={{ left: pct(value) + '%' }} />}
      </div>
      <div className="calbar__scale mono">
        <span>-32,768</span>
        <span>0</span>
        <span>32,767</span>
      </div>
    </div>
  )
}

/**
 * Travel as a fraction of the ADC range, with a descriptive band.
 *
 * Descriptive, not prescriptive, and never styled as an error: 40% is the expected healthy
 * result for a short-arc axis, and "fit a different sensor" is unactionable at calibration time
 * because it is soldered in by then. Thresholds live here so retuning after the hall-sensor
 * bench is one edit.
 */
const TRAVEL_BANDS = [
  { at: 0.6, label: 'Good', tone: 'ok' },
  { at: 0.3, label: 'Workable', tone: '' },
  { at: 0, label: 'Low', tone: 'warn' }
] as const

function travelQuality(min?: number, max?: number) {
  if (min === undefined || max === undefined) return null
  const counts = max - min
  const frac = counts / 65535
  const band = TRAVEL_BANDS.find((b) => frac >= b.at)!
  return { counts, pct: Math.round(frac * 100), ...band }
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

  const device = s.device
  const present = useMemo(() => device?.axes.filter((a) => a.present) ?? [], [device])
  const draft = s.drafts[s.axis]
  const stored = device?.axes[s.axis]
  const cap = s.capture
  const inst = instruction(s)
  const invalid = controller.invalidAxis()
  const writing = !!s.write

  // Values on screen: the draft if the user has captured one, otherwise what the device holds.
  const shown = draft ?? (stored?.calibrated ? stored : undefined)
  const travel = travelQuality(shown?.min, shown?.max)
  const selfCentring = draft?.selfCentring ?? cap?.selfCentring ?? true
  const order: Point[] = selfCentring ? ['stopA', 'stopB', 'centre'] : ['stopA', 'stopB']

  /**
   * A held "Captured X" moment before the instruction moves on.
   *
   * Without it a point was captured and the text changed in the same frame, which read as the
   * flow skipping a step rather than completing one. Presentation only — the reducer advances
   * immediately, as it should.
   */
  const [beat, setBeat] = useState<{ p: Point; v: number } | null>(null)
  const prev = useRef<Partial<Record<Point, number>>>({})
  useEffect(() => {
    const now = (cap?.current ?? {}) as Partial<Record<Point, number>>
    for (const p of ['stopA', 'stopB', 'centre'] as Point[]) {
      if (now[p] !== undefined && prev.current[p] === undefined) setBeat({ p, v: now[p]! })
    }
    prev.current = cap ? { ...now } : {}
  }, [cap])
  useEffect(() => {
    if (!beat) return
    const t = setTimeout(() => setBeat(null), 1200)
    return () => clearTimeout(t)
  }, [beat])

  return (
    <div className="calmodal">
      <div className="calmodal__sheet">
        <div className="calmodal__head">
          <span className="section-h">Axis calibration</span>
          <span className="meta meta--warn">DCS link paused while this is open</span>
          <button className="calbtn" onClick={onClose} disabled={writing}>
            Close
          </button>
        </div>

        <div className="calmodal__body">
          {/* axis rail */}
          <div className="calrail">
            {present.map((a) => {
              const d = s.drafts[a.idx]
              const label = d ? 'EDIT' : a.calibrated ? 'CAL' : 'RAW'
              return (
                <button
                  key={a.idx}
                  className={`calrail__item${a.idx === s.axis ? ' is-on' : ''}`}
                  onClick={() => void controller.selectAxis(a.idx)}
                  disabled={writing || s.switchingTo !== undefined}
                >
                  <span>{AXIS_LABELS[a.idx]}</span>
                  <span className={`calrail__tag calrail__tag--${label.toLowerCase()}`}>
                    {s.switchingTo === a.idx ? '…' : label}
                  </span>
                </button>
              )
            })}
          </div>

          {/* detail */}
          <div className="caldetail">
            <div className="calhead">
              <div>
                <div className="calnum__label">Raw input</div>
                <div className="calnum calnum--lg">{s.live ? fmt(s.live.raw) : '—'}</div>
              </div>
              <div className="calhead__sep" />
              <div>
                <div className="calnum__label">To DCS · through stored calibration</div>
                <div className="calnum calnum--lg calnum--blue">
                  {s.live ? fmt(s.live.cal) : '—'}
                </div>
              </div>
              {travel && (
                <div className="calhead__travel">
                  <div className="calnum__label">Recorded travel</div>
                  <div>
                    <span className={`calpct calpct--${travel.tone}`}>{travel.pct}%</span>{' '}
                    <span className="mono">{fmtSpan(travel.counts)} counts</span>{' '}
                    <span className={`calpct calpct--${travel.tone}`}>
                      {travel.label.toUpperCase()}
                    </span>
                  </div>
                </div>
              )}
            </div>

            <RangeBar
              value={s.live?.raw}
              min={shown?.min}
              centre={shown?.centre}
              max={shown?.max}
            />

            <div className="calcards">
              {(['min', 'centre', 'max'] as const).map((k) => (
                <div key={k} className="calcard">
                  <div className="calnum__label">{k}</div>
                  <div className="calnum">{shown ? fmt(shown[k]) : '—'}</div>
                </div>
              ))}
            </div>

            <div className="calstep">
              <div className="calstep__title">
                {beat ? `Captured ${POINT_LABEL[beat.p]}` : inst.title}
              </div>
              <div className="calstep__detail">
                {beat ? <span className="mono">{fmt(beat.v)}</span> : inst.detail}
              </div>
            </div>

            {cap && cap.phase !== 'complete' && (
              <Steps
                order={order}
                current={cap.phase === 'capturing' ? (cap.step as Point) : undefined}
                captured={cap.current as Partial<Record<Point, number>>}
                progress={cap.awaitingMovement ? 0 : holdProgress(cap)}
                justCaptured={beat?.p}
              />
            )}

            {cap?.awaitingConfirmation && (
              <div className="meta">holding — waiting for the axis to report again</div>
            )}

            <div className="calwarn">
              The joystick stays live to DCS throughout — sweeping this axis will move whatever it
              is bound to in the sim. Pause the mission or unbind the axis before capturing.
            </div>

            <div className="calrest">
              <span className="calnum__label">Rest position</span>
              <div className="calseg">
                <button
                  className={`calseg__btn${selfCentring ? ' is-on' : ''}`}
                  onClick={() => controller.setSelfCentring(true)}
                  disabled={writing || !draft}
                >
                  Self-centring
                </button>
                <button
                  className={`calseg__btn${!selfCentring ? ' is-on' : ''}`}
                  onClick={() => controller.setSelfCentring(false)}
                  disabled={writing || !draft}
                >
                  None
                </button>
              </div>
              <span className="meta">
                {selfCentring
                  ? 'Returns to a rest position — centre is captured, not assumed.'
                  : 'No rest position — centre is the midpoint of the captured travel.'}
              </span>
            </div>

            <div className="calactions">
              {cap?.phase === 'rejected' ? (
                <button className="calbtn calbtn--primary" onClick={() => controller.retry()}>
                  Redo that sweep
                </button>
              ) : !cap ? (
                <button
                  className="calbtn calbtn--primary"
                  onClick={() => controller.startCapture(selfCentring)}
                  disabled={writing}
                >
                  {draft || stored?.calibrated ? 'Re-capture travel' : 'Start travel capture'}
                </button>
              ) : (
                <span className="meta">
                  {sweepsRemaining(cap)} sweep{sweepsRemaining(cap) === 1 ? '' : 's'} remaining
                  {cap.interruptions > 0 ? ` · ${cap.interruptions} interruptions` : ''}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* footer: write + failures */}
        <div className="calmodal__foot">
          {s.failure && (
            <div className="calfail">
              <b>{s.failure.kind === 'timeout' ? 'No answer from the device' : 'Refused'}</b>{' '}
              {s.failure.message}
              {s.storedBeforeFailure?.length ? (
                <span>
                  {' '}
                  Stored before stopping:{' '}
                  {s.storedBeforeFailure.map((i) => AXIS_LABELS[i]).join(', ')}.
                </span>
              ) : null}
            </div>
          )}
          {s.write && (
            <span className="meta">
              {s.write.phase === 'writing' ? 'Writing' : 'Reading back'}{' '}
              {AXIS_LABELS[s.write.queue[s.write.at]!]} — {s.write.at + 1} of {s.write.queue.length}
            </span>
          )}
          {invalid && !writing && (
            <span className="meta meta--warn">
              {AXIS_LABELS[invalid.axis]}: {invalid.reason}
            </span>
          )}
          <div className="calmodal__actions">
            {stored?.calibrated && !writing && (
              <button className="calbtn" onClick={() => void controller.deleteAxis(s.axis)}>
                Delete calibration
              </button>
            )}
            <button
              className="calbtn calbtn--primary"
              onClick={() => void controller.save()}
              disabled={writing || !controller.dirtyAxes().length || !!invalid}
            >
              {writing ? 'Writing…' : `Write ${controller.dirtyAxes().length || ''}`.trim()}
            </button>
          </div>
        </div>
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

  // The device is the source of truth for badges; a different board clears drafts.
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
      // Badges follow the device, so refresh from it rather than from what we think we wrote.
      const r = await window.skyhawk?.calRead()
      if (r?.ok) setCal({ cal: r.value })
    }
  }
}
