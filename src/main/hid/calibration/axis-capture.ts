// (In shared until the calibration workflow moved to main, R3.1.)
//
// Axis travel capture (pure, no Node/Electron deps, fully testable).
//
// The client owns the whole calibration procedure — the device stores three numbers and models
// none of this. Everything here is driven by measurements from the bench rig; the reasoning is
// kept next to the rules because the numbers alone do not explain themselves.
//
// The one measurement that shapes the entire design: **the node emits only on change.**
// AnalogInput gates on a 128-count hysteresis, so a settled axis sends nothing, and across every
// sample collected from the rig there was not one repeated value. A dwell defined as "N
// consecutive samples agreed" can therefore never complete. Dwell has to be wall-clock against
// the last value received.
//
// The second fact, which pulls the other way: **RAW frames are droppable.** The gateway discards
// a whole frame rather than stall the relay when the CDC buffer is short. So elapsed time alone
// is not proof that a value is real — the sequence settled -> spike -> (return frame lost) leaves
// a spike sitting as the current value with nothing following it. A hold therefore needs both:
// the time to elapse, and a second in-band sample corroborating that the value is a real rest
// rather than a lone reading whose successor never arrived.
//
// The SEQ counter cannot substitute for that. A gap is only visible on the next arriving frame,
// and in the case that matters no next frame arrives.

import type {
  CaptureConfig,
  CapturedSweep,
  CaptureResult,
  CaptureState
} from '@shared/hid/calibration'

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  bandCounts: 300,
  endpointHoldMs: 1500,
  centreStableMs: 5000,
  centreCapMs: 15000,
  minTravelCounts: 2000,
  shortfallFraction: 0.15,
  sweepsRequired: 3
}

/**
 * Unsigned 0–65535, as the wire and device storage use — and as the dialog displays. The client
 * applies no offset anywhere, so there is nothing to convert on the way in or out.
 */
export interface CaptureSample {
  /** Stamped on arrival in main, not at render time — batching would otherwise skew dwell. */
  t: number
  raw: number
}

export function beginCapture(
  now: number,
  /** Defaults to true for every axis; see CaptureState.selfCentring. */
  selfCentring = true,
  config: CaptureConfig = DEFAULT_CAPTURE_CONFIG
): CaptureState {
  return {
    selfCentring,
    config,
    phase: 'capturing',
    step: 'stopA',
    accepted: [],
    current: {},
    ref: null,
    refSince: now,
    now,
    stepSince: now,
    centreSamples: [],
    interruptions: 0,
    corroborated: false,
    awaitingConfirmation: false,
    stepFrom: null,
    movedBy: 0,
    awaitingMovement: false
  }
}

/** How long the current step must hold before it commits. */
function holdTarget(s: CaptureState): number {
  return s.step === 'centre' ? s.config.centreStableMs : s.config.endpointHoldMs
}

/**
 * Progress of the current hold, 0..1 — for a progress indicator, not a decision.
 */
export function holdProgress(s: CaptureState): number {
  if (s.phase !== 'capturing' || s.ref === null) return 0
  return Math.min(1, (s.now - s.refSince) / holdTarget(s))
}

/**
 * Milliseconds left on the current hold — for a countdown, not a decision.
 *
 * Floors at zero rather than going negative: once the time is up the hold is waiting on
 * corroboration or on the movement gate, and a countdown running below zero would suggest the
 * clock is what is holding things up.
 */
export function holdRemainingMs(s: CaptureState): number {
  if (s.phase !== 'capturing' || s.ref === null) return holdTarget(s)
  return Math.max(0, holdTarget(s) - (s.now - s.refSince))
}

/**
 * Whether the axis has travelled far enough this step for a hold to mean anything.
 *
 * This is the honest "are they still sweeping, or are they at the stop?" test, and the UI needs
 * it because `awaitingMovement` cannot answer that question: that flag is only raised once a
 * full hold has elapsed with too little travel, so for the first second of every step it reads
 * false whether or not the user has touched the axis.
 */
export function hasTravelled(s: CaptureState): boolean {
  return s.movedBy >= s.config.minTravelCounts
}

/**
 * Judge a finished sweep against the best travel seen so far.
 *
 * **Asymmetric, because the physics is asymmetric.** A mechanical stop is fixed: you cannot
 * push past it, but you can easily stop short of it. So a reading can only ever under-report
 * travel. A sweep that reaches *wider* than anything before it is not an anomaly, it is a
 * better swing — accept it. Only a sweep that falls materially short means the user did not
 * complete the motion, and that is worth telling them.
 *
 * This is also why the first sweep needs no special handling. A short first sweep is banked as
 * the reference, a fuller second sweep is "wider, so accept", and widest-wins picks the good
 * one. Only a short *later* sweep is rejected. Nothing has to guess which sweep to trust.
 */
function judgeSweep(s: CaptureState, sweep: CapturedSweep): string | null {
  if (s.accepted.length === 0) return null // nothing to compare against yet

  const bestMin = Math.min(...s.accepted.map((a) => a.min))
  const bestMax = Math.max(...s.accepted.map((a) => a.max))
  const slack = (bestMax - bestMin) * s.config.shortfallFraction

  if (sweep.min - bestMin > slack) {
    return 'That swing stopped short of the low end. Sweep all the way to the stop, slowly.'
  }
  if (bestMax - sweep.max > slack) {
    return 'That swing stopped short of the high end. Sweep all the way to the stop, slowly.'
  }
  return null
}

/**
 * Reconcile accepted sweeps into the values to commit.
 *
 * **Widest wins**, for the same reason the rejection rule is asymmetric: every reading is at or
 * below the true extreme, so the widest is both closest to the truth and still inside it —
 * which satisfies #46's "bias endpoints inward" for free. A median would systematically discard
 * the user's best swings and leave the axis topping out early on every deflection. This is only
 * safe because the hold requirement means nothing can be spuriously wide.
 *
 * Centre is the mean of the release samples. A settled axis emits almost nothing, so no single
 * hold can beat the ±160-count uncertainty floor; averaging independent releases is the only
 * thing that improves on it.
 */
export function reconcile(s: CaptureState): CaptureResult {
  const min = Math.min(...s.accepted.map((a) => a.min))
  const max = Math.max(...s.accepted.map((a) => a.max))
  const centres = s.accepted.map((a) => a.centre).filter((c): c is number => c !== undefined)

  // The default centre is always the midpoint. It applies whenever no rest position was
  // captured — a non-self-centring axis, which is never asked to release. Rounded rather than
  // truncated, since truncating would bias every such axis one count low.
  //
  // It needs no firmware special case: with centre at the midpoint both segments get equal
  // input and output width, so the two-segment map collapses to a single linear stretch to
  // within one count — exactly the behaviour an axis with no rest position wants.
  const centre = centres.length
    ? Math.round(centres.reduce((a, b) => a + b, 0) / centres.length)
    : midpoint(min, max)

  return { min, centre, max }
}

/**
 * The default centre: half way between the endpoints.
 */
export function midpoint(min: number, max: number): number {
  return Math.round((min + max) / 2)
}

/** Close the sweep in progress: judge it, bank it or ask for a repeat. */
function finishSweep(s: CaptureState): CaptureState {
  const a = s.current.stopA!
  const b = s.current.stopB!
  const sweep: CapturedSweep = {
    min: Math.min(a, b),
    max: Math.max(a, b),
    centre: s.current.centre
  }

  const rejection = judgeSweep(s, sweep)
  if (rejection) {
    return { ...s, phase: 'rejected', rejection, current: {}, ref: null }
  }

  const accepted = [...s.accepted, sweep]
  if (accepted.length >= s.config.sweepsRequired) {
    const done: CaptureState = {
      ...s,
      accepted,
      phase: 'complete',
      current: {},
      ref: null,
      rejection: undefined
    }
    return { ...done, result: reconcile(done) }
  }

  return {
    ...s,
    accepted,
    phase: 'capturing',
    step: 'stopA',
    current: {},
    ref: null,
    refSince: s.now,
    stepSince: s.now,
    centreSamples: [],
    interruptions: 0,
    corroborated: false,
    awaitingConfirmation: false,
    stepFrom: null,
    movedBy: 0,
    awaitingMovement: false,
    rejection: undefined
  }
}

/** Commit the value the current step was holding and move on. */
function commitStep(s: CaptureState, value: number): CaptureState {
  const current = { ...s.current, [s.step]: value }
  const next: CaptureState = {
    ...s,
    current,
    ref: null,
    refSince: s.now,
    stepSince: s.now,
    centreSamples: [],
    corroborated: false,
    awaitingConfirmation: false,
    stepFrom: null,
    movedBy: 0,
    awaitingMovement: false
  }

  if (s.step === 'stopA') return { ...next, step: 'stopB' }
  if (s.step === 'stopB') {
    // A non-self-centring axis is never asked to release and wait — there is no rest position to
    // capture, so prompting for one would ask the user to do something meaningless.
    return s.selfCentring ? { ...next, step: 'centre' } : finishSweep(next)
  }
  return finishSweep(next)
}

/**
 * Advance time without a new sample.
 *
 * Essential rather than a convenience: a held axis emits nothing, so if dwell were only
 * evaluated on arrival, a perfectly steady hold would never complete. The UI ticks this.
 */
export function tick(s: CaptureState, now: number): CaptureState {
  if (s.phase !== 'capturing') return { ...s, now }
  const next = { ...s, now }

  if (next.step === 'centre' && now - next.stepSince >= next.config.centreCapMs) {
    // Never settled inside the band. Use what arrived rather than stranding the user — but only
    // the rest cluster, never the release transit. Collection starts the moment stopB commits,
    // so the early samples are the spring travelling back from the mechanical stop; averaging
    // those in would pull the stored centre toward the stop the user last held. Bounded two
    // ways: recent in time, and near the value currently being timed.
    return commitStep(next, restCluster(next))
  }

  if (next.ref !== null && now - next.refSince >= holdTarget(next)) {
    // A steady value proves nothing if the axis never went anywhere. Without this the capture
    // commits wherever it happened to be sitting when the step opened.
    if (next.movedBy < next.config.minTravelCounts) {
      return { ...next, awaitingMovement: true }
    }
    // Elapsed time alone is not enough either. An uncorroborated reference may be a spike whose
    // return frame was dropped, and committing it would write a wrong endpoint to flash that
    // widest-wins then protects. Keep holding and let the UI explain why.
    if (!next.corroborated) return { ...next, awaitingConfirmation: true }
    return commitStep(next, next.ref)
  }
  return next
}

/**
 * The settled readings at the end of a centre step, excluding release transit.
 *
 * Bounded by recency alone, and anchored to the last sample rather than to the clock. Transit
 * is at the *start* of the step by construction — collection begins when stopB commits, while
 * the spring is still travelling back from the mechanical stop — so a trailing window excludes
 * it without needing to reason about values at all.
 *
 * Filtering by proximity to the current reference was tried and is wrong: when the axis jitters
 * symmetrically about rest, the reference is whichever side it last landed on, so the "cluster"
 * is one extreme rather than the centre between them. Anchoring the window to the clock instead
 * of the last sample is also wrong — emission is sparse and change-gated, so a stream that went
 * quiet before the cap would leave the window empty.
 *
 * The mean, not the median: symmetric jitter averages to the rest position, whereas a median
 * over an alternating stream lands on one side or the other depending on how many samples
 * happened to arrive.
 */
function restCluster(s: CaptureState): number {
  const last = s.centreSamples.at(-1)
  if (!last) return s.ref ?? 0
  const since = last.t - s.config.centreStableMs
  const recent = s.centreSamples.filter((x) => x.t >= since)
  return Math.round(recent.reduce((a, b) => a + b.raw, 0) / recent.length)
}

/**
 * Feed one RAW sample.
 */
export function push(s: CaptureState, sample: CaptureSample): CaptureState {
  if (s.phase !== 'capturing') return { ...s, now: sample.t }

  let next: CaptureState = { ...s, now: sample.t }
  const from = next.stepFrom ?? sample.raw
  next = {
    ...next,
    stepFrom: from,
    movedBy: Math.max(next.movedBy, Math.abs(sample.raw - from)),
    awaitingMovement: false
  }
  if (next.step === 'centre') {
    next = { ...next, centreSamples: [...next.centreSamples, { t: sample.t, raw: sample.raw }] }
  }

  if (next.ref === null) {
    next = { ...next, ref: sample.raw, refSince: sample.t, corroborated: false }
  } else if (Math.abs(sample.raw - next.ref) > next.config.bandCounts) {
    // Moved out of band: a new value to time, and the previous hold is abandoned. A spike lands
    // here and restarts the clock, so when its return frame arrives the hold completes on the
    // settled reading. When that return frame is *dropped* instead, this alone would leave the
    // spike as the reference — which is what `corroborated` exists to catch.
    next = {
      ...next,
      ref: sample.raw,
      refSince: sample.t,
      corroborated: false,
      awaitingConfirmation: false,
      interruptions: next.interruptions + 1
    }
  } else {
    // Inside the band: noise, not movement. The reference and its clock are left alone — and
    // this sample is the confirmation that the reference is a real hold rather than a lone
    // reading whose successor was dropped.
    next = { ...next, corroborated: true, awaitingConfirmation: false }
  }

  return tick(next, sample.t)
}

/**
 * Acknowledge a rejected sweep and redo it. Accepted sweeps are kept.
 */
export function retrySweep(s: CaptureState, now: number): CaptureState {
  if (s.phase !== 'rejected') return s
  return restartSweep(s, now)
}

/**
 * Throw away the sweep in progress and start it again from the first stop. Accepted sweeps are
 * kept.
 *
 * For a sweep that was interrupted rather than rejected — the serial link closing mid-capture.
 * Its samples stop at the close and the gap is not visible in the data, so the half-finished
 * sweep cannot be trusted to continue: a hold that spans the outage would be timed across it.
 */
export function restartSweep(s: CaptureState, now: number): CaptureState {
  return {
    ...s,
    phase: 'capturing',
    step: 'stopA',
    current: {},
    ref: null,
    refSince: now,
    now,
    stepSince: now,
    centreSamples: [],
    interruptions: 0,
    corroborated: false,
    awaitingConfirmation: false,
    stepFrom: null,
    movedBy: 0,
    awaitingMovement: false,
    rejection: undefined
  }
}

/**
 * Sweeps still needed. Rejected attempts do not count toward it.
 */
export function sweepsRemaining(s: CaptureState): number {
  return Math.max(0, s.config.sweepsRequired - s.accepted.length)
}
