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

/**
 * Every threshold in one block, as #46 requires, so retuning after the hall-sensor bench is a
 * one-line change rather than a hunt through render code.
 */
export interface CaptureConfig {
  /**
   * Movement smaller than this leaves the held value alone.
   *
   * A detector that restarted on *any* new sample would race the noise: sometimes completing,
   * sometimes not, depending how jittery the individual axis is. So movement has to clear a
   * threshold — but not one so wide that it accepts a stop the user has not actually reached.
   *
   * **This is the least-settled constant here.** Measured rest spread on the bench rig was
   * 320–387 counts peak-to-peak (stdev 28.7, post-EWMA) at roughly one sample per second, which
   * argues for something above 400. It is set below that deliberately, because 500 raw counts is
   * ~885 output counts after a typical 1.77× stretch — 2.7% of a half-axis — and accepting a
   * stop that early is its own kind of wrong.
   *
   * The trade lands on hold *duration*, not correctness: a rest swing across most of the noise
   * envelope restarts the timer, so a hold occasionally takes several seconds rather than one.
   * The node's 128-count hysteresis keeps most steps under the threshold, so this should be
   * uncommon. `interruptions` is the instrument for tuning it — a climbing count during a hold
   * means the band is too tight for that axis.
   *
   * Worth knowing for the hall-sensor bench: a fixed raw band is a larger *fraction* of travel
   * on a low-travel axis. The bench stick spans ~37000 counts, but a short-arc axis may develop
   * only half that, doubling this threshold's relative size exactly where resolution is already
   * tightest.
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
  /**
   * How far the axis must move within a step before any hold may commit.
   *
   * Without this the capture starts timing the moment it opens: the axis sits at rest, noise
   * arrives, the value holds for a second, and the *rest position* is committed as the first
   * stop — before the user has touched anything. The same then happens for the second stop.
   *
   * Sized well above the 387-count noise floor and the 300-count band, and well below any real
   * travel: the bench axis spans ~37000 counts and #46 notes even a short-arc axis develops
   * several thousand. It is a movement gate, not a travel measurement.
   */
  minTravelCounts: number
  /** Accepted sweeps needed before the axis is done. Rejected attempts do not count. */
  sweepsRequired: number
}

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  bandCounts: 300,
  endpointHoldMs: 1000,
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
  /** First value seen in this step, and the furthest the axis has moved from it. */
  stepFrom: number | null
  movedBy: number
  /**
   * The hold has elapsed but the axis has not moved far enough this step to mean anything.
   *
   * Surfaced so the UI can say "move the axis" rather than showing a full progress bar that will
   * never commit.
   */
  awaitingMovement: boolean
  /**
   * Samples gathered during the current centre step, timestamped for the capped-out fallback.
   *
   * Timestamps are load-bearing: collection begins the instant stopB commits, so the early
   * entries are the spring travelling from the mechanical stop back toward rest. Averaging that
   * transit together with the rest readings would drag the stored centre toward the last stop.
   */
  centreSamples: { t: number; raw: number }[]
  /**
   * Whether a second in-band sample has confirmed the current reference.
   *
   * Without this a lone spike commits. RAW is explicitly droppable under CDC back-pressure, so
   * the sequence settled -> spike -> (return frame dropped) leaves the spike as the reference
   * with nothing following it, and a hold evaluated purely on elapsed time would commit it —
   * which widest-wins would then preserve over every good sweep.
   *
   * The SEQ gap cannot rescue this: a gap is only visible on the next arriving frame, and here
   * nothing arrives. Corroboration is the only signal available.
   */
  corroborated: boolean
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
  /**
   * The hold has run long enough but nothing has confirmed the value yet.
   *
   * Surfaced so the UI can say "holding — waiting for confirmation" rather than appearing hung.
   * Normally under a second: measured rest noise is 387 counts peak-to-peak, comfortably above
   * the node's 128-count emission threshold, so samples do keep arriving at roughly 1/s.
   */
  awaitingConfirmation: boolean
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

/** Feed one RAW sample. */
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
    corroborated: false,
    awaitingConfirmation: false,
    stepFrom: null,
    movedBy: 0,
    awaitingMovement: false,
    rejection: undefined
  }
}

/** Sweeps still needed. Rejected attempts do not count toward it. */
export function sweepsRemaining(s: CaptureState): number {
  return Math.max(0, s.config.sweepsRequired - s.accepted.length)
}
