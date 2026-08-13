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

/**
 * Every threshold in one block, as #46 requires, so retuning after the hall-sensor bench is a
 * one-line change rather than a hunt through render code.
 */
export interface CaptureConfig {
  /**
   * Movement smaller than this leaves the held value alone.
   *
   * Measured rest spread on the bench rig was 387 counts peak-to-peak (stdev 28.7, post-EWMA),
   * arriving at roughly one sample per second. A detector that restarted on *any* new sample
   * would race that noise: sometimes it completes, sometimes it never does, depending how
   * jittery the individual axis is. The band has to clear the noise — but not by so much that
   * it accepts a stop the user has not actually reached.
   */
  bandCounts: number
  /** How long an endpoint must stay inside the band before it counts as held. */
  endpointHoldMs: number
  /** Stability required at rest before a centre sample is taken. */
  centreStableMs: number
  /** Give up waiting for stability and use what was gathered. */
  centreCapMs: number
  /**
   * How far short of the best travel a sweep may fall before it is rejected.
   *
   * Asymmetric by design — see `judgeSweep`.
   *
   * Sized off real variation, not a round number: two honest sweeps of the same bench axis gave
   * 16538…48933 and 13973…50925, a 6.9% shortfall on min and 5.4% on max against the wider
   * travel. A threshold near 10% would sit close enough to that to reject swings the user did
   * nothing wrong on. Erring permissive is also the cheaper mistake here — with widest-wins an
   * accepted-but-short sweep contributes nothing to the result, so this rule coaches the user
   * rather than protecting the numbers.
   */
  shortfallFraction: number
  /** Accepted sweeps needed before the axis is done. Rejected attempts do not count. */
  sweepsRequired: number
}

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  bandCounts: 500,
  endpointHoldMs: 1000,
  centreStableMs: 5000,
  centreCapMs: 15000,
  shortfallFraction: 0.15,
  sweepsRequired: 3
}

/** Unsigned 0–65535, as the wire and device storage use. Convert for display, never here. */
export interface CaptureSample {
  /** Stamped on arrival in main, not at render time — batching would otherwise skew dwell. */
  t: number
  raw: number
}

/**
 * What the user is being asked to do.
 *
 * `stopA`/`stopB` are deliberately not "min" and "max": we do not care which direction the user
 * sweeps first, and an inverted axis would make the labels lie. Whichever two values are held,
 * the lower is the min.
 */
export type CaptureStep = 'stopA' | 'stopB' | 'centre'

export type CapturePhase =
  | 'idle'
  | 'capturing'
  /** A sweep fell short. Waiting for the user to acknowledge and redo that sweep. */
  | 'rejected'
  | 'complete'

export interface CapturedSweep {
  min: number
  max: number
  /** Absent on a non-self-centring axis, which is never asked to release. */
  centre?: number
}

export interface CaptureResult {
  min: number
  centre: number
  max: number
}

export interface CaptureState {
  /**
   * Whether this axis returns to a rest position when released.
   *
   * A per-axis setting, not a property of which axis it is, and **it defaults to true for every
   * axis** — not inferred from `controlId`. Capturing a rest position is the cautious default:
   * silently deriving a midpoint for an axis that does have one is how a resting offset gets
   * baked in (+4669 on the bench rig before this feature existed). The user marks throttle,
   * brakes or zoom as non-centring in the flow, which makes it a stated choice rather than an
   * assumption the client made on their behalf.
   *
   * The device never reports this — there is deliberately no axis-type field in the blob.
   */
  selfCentring: boolean
  config: CaptureConfig
  phase: CapturePhase
  step: CaptureStep
  /** Sweeps banked so far. Only accepted ones are here. */
  accepted: CapturedSweep[]
  /** Values held during the sweep in progress. */
  current: { stopA?: number; stopB?: number; centre?: number }
  /** Value the stability detector is currently timing, and since when. */
  ref: number | null
  refSince: number
  /** Latest sample time seen, so dwell can be evaluated without a new sample. */
  now: number
  /** When the current step began — the centre cap measures from here. */
  stepSince: number
  /** Samples gathered during the current centre step, for the capped-out fallback. */
  centreSamples: number[]
  /**
   * Times the hold restarted during this sweep.
   *
   * This *is* the spike count. A spike knocks the reference out of band, the value returns, and
   * the hold completes on the settled reading — so a spike can never become an endpoint, and no
   * separate outlier filter is needed. What is worth showing the user is how often their hold
   * was interrupted.
   */
  interruptions: number
  /** Why the last sweep was rejected, for the UI to explain. */
  rejection?: string
  result?: CaptureResult
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
    interruptions: 0
  }
}

/** How long the current step must hold before it commits. */
function holdTarget(s: CaptureState): number {
  return s.step === 'centre' ? s.config.centreStableMs : s.config.endpointHoldMs
}

/** Progress of the current hold, 0..1 — for a progress indicator, not a decision. */
export function holdProgress(s: CaptureState): number {
  if (s.phase !== 'capturing' || s.ref === null) return 0
  return Math.min(1, (s.now - s.refSince) / holdTarget(s))
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

/** The default centre: half way between the endpoints. */
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
    centreSamples: []
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
    // Never settled inside the band. Use the mean of what arrived rather than abandoning the
    // sweep — it is the best estimate available, and refusing to finish would strand the user.
    const mean = next.centreSamples.length
      ? Math.round(next.centreSamples.reduce((a, b) => a + b, 0) / next.centreSamples.length)
      : (next.ref ?? 0)
    return commitStep(next, mean)
  }

  if (next.ref !== null && now - next.refSince >= holdTarget(next)) {
    return commitStep(next, next.ref)
  }
  return next
}

/** Feed one RAW sample. */
export function push(s: CaptureState, sample: CaptureSample): CaptureState {
  if (s.phase !== 'capturing') return { ...s, now: sample.t }

  let next: CaptureState = { ...s, now: sample.t }
  if (next.step === 'centre') next = { ...next, centreSamples: [...next.centreSamples, sample.raw] }

  if (next.ref === null) {
    next = { ...next, ref: sample.raw, refSince: sample.t }
  } else if (Math.abs(sample.raw - next.ref) > next.config.bandCounts) {
    // Moved out of band: a new value to time, and the previous hold is abandoned. A spike lands
    // here, restarts the clock, and is gone by the time the hold completes — which is precisely
    // why it can never be committed as an endpoint.
    next = {
      ...next,
      ref: sample.raw,
      refSince: sample.t,
      interruptions: next.interruptions + 1
    }
  }
  // Inside the band: noise, not movement. The reference and its clock are left alone.

  return tick(next, sample.t)
}

/** Acknowledge a rejected sweep and redo it. Accepted sweeps are kept. */
export function retrySweep(s: CaptureState, now: number): CaptureState {
  if (s.phase !== 'rejected') return s
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
    rejection: undefined
  }
}

/** Sweeps still needed. Rejected attempts do not count toward it. */
export function sweepsRemaining(s: CaptureState): number {
  return Math.max(0, s.config.sweepsRequired - s.accepted.length)
}
