// HID calibration topic contract (arch-phase0-v2 §2.3): axis calibration on the device, the
// client's cache of what it confirmed storing, and the capture shapes. Imported by main, preload
// and the renderer.

/**
 * One RAW sample, timestamped **on arrival in main**.
 *
 * The timestamp is not optional bookkeeping. Samples are batched to the renderer, so wall-clock
 * at render time says when the batch flushed, not when the axis moved — and the capture logic's
 * dwell test is "the last received value has not changed for N ms". Reading the flush time would
 * make dwell depend on IPC scheduling.
 */
export interface CalRawSample {
  t: number
  idx: number
  /** Pre-transform sensor reading. Unsigned 0–65535, and displayed in those units. */
  raw: number
  /**
   * The same sample through the calibration the device currently holds — not a preview of the
   * endpoints being captured.
   *
   * Also unsigned 0–65535. One convention across this whole channel: converting this value but
   * not the endpoints is the silent-failure case.
   */
  cal: number
}

/** Stored calibration as last read back from the device. Drives the badges. */
export interface CalSnapshot {
  presentMask: number
  calibratedMask: number
  axes: {
    idx: number
    controlId: number
    min: number
    centre: number
    max: number
    deadzone: number
    present: boolean
    calibrated: boolean
  }[]
  /** USB serial of the board this came from; the restore cache is keyed by it. */
  serialNumber?: string
}

/**
 * Outcome of a calibration exchange.
 *
 * A discriminated result rather than a thrown error, because `ipcRenderer.invoke` flattens a
 * rejection into a plain Error — which would collapse the one distinction the failure design
 * depends on. A **timeout** and a **nack** need opposite messages: a timeout means no frame
 * came back, so the connection is suspect and the outcome is genuinely unknown; a nack means
 * the device answered and refused, so the connection is fine and the values are the problem.
 *
 * `timeout` deliberately does not imply "nothing was written". It cannot distinguish "never
 * received" from "wrote it and the reply was lost", so callers re-read and report what the
 * device says.
 */
export type CalFailure =
  | { kind: 'timeout'; message: string }
  | { kind: 'nack'; reason: number; reasonName: string; detail: number; message: string }
  | { kind: 'offline'; message: string }
  | { kind: 'error'; message: string }

export type CalResult<T> = { ok: true; value: T } | ({ ok: false } & CalFailure)

export interface CalHello {
  proto: number
  blobVersion: number
  axisSlots: number
  fw: { major: number; minor: number; patch: number }
}

export interface CalCommitAxis {
  idx: number
  /**
   * Unsigned 0–65535 calibration-channel counts — positions in the node's ADC space, exactly as
   * the device stores them.
   *
   * **Pass through unchanged.** These are the same units the dialog displays and the capture
   * logic works in, so there is no conversion to undo. The client applies no offset anywhere;
   * the −32768 lives once in the firmware, at SimGateway.cpp:216, on the way into the HID report.
   */
  min: number
  centre: number
  max: number
}

/**
 * One axis as the device confirmed storing it.
 *
 * `selfCentring` rides along because it is part of the calibration and the device deliberately
 * does not hold it — there is no axis-type field in the blob. It decides whether centre was
 * measured at rest or derived as the midpoint, so restoring the three numbers without it would
 * restore values whose meaning has been lost.
 */
export interface CachedAxis {
  min: number
  centre: number
  max: number
  selfCentring: boolean
}

export interface CachedBoard {
  /** When the device last confirmed these values, ISO 8601. Shown before restoring. */
  confirmedAt: string
  axes: Record<number, CachedAxis>
}

/**
 * Keyed by board serial, never by VID/PID — those are identical across every OpenSkyhawk gateway,
 * so a VID/PID key would silently push one board's calibration onto another.
 */
export interface CalCache {
  version: 1
  boards: Record<string, CachedBoard>
}

/** One axis on its way into the cache: the confirmed values plus the setting the device cannot hold. */
export interface CalCacheEntry extends CachedAxis {
  idx: number
}

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
  /**
   * How long an endpoint must stay inside the band before it counts as held.
   *
   * **This is the only thing separating a stop from a hesitation.** Both look identical to the
   * detector: the movement gate has already been satisfied by the sweep itself, so a pause
   * anywhere along the travel is a candidate endpoint. Observed on the rig at 1000 ms — a sweep
   * that paused at 33128 (dead centre) banked it as the lower stop, while the same axis reached
   * 11950 on the next sweep.
   *
   * Raised to 1500 ms rather than solved structurally, because widest-wins already keeps a short
   * sweep out of the stored numbers and the rejection rule catches a later one. If holds keep
   * committing mid-sweep, the real fix is a grace window after each commit that reopens the step
   * when the axis travels further the same way — a stop is a place you cannot pass, so passing
   * it is proof it was not one.
   */
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

/** This topic's main -> renderer pushes; shared/app assembles them into `PushChannels`. */
export interface CalibrationPushChannels {
  'cal:data': CalSnapshot
  'cal:raw': CalRawSample[]
}

/** Push channel names (main -> renderer). */
export const CALIBRATION_PUSH = {
  calData: 'cal:data',
  calRaw: 'cal:raw'
} as const

/** Intent channel names (renderer -> main, invoke/response). */
export const CALIBRATION_CTRL = {
  calHello: 'cal:hello',
  calRead: 'cal:read',
  calSessionOpen: 'cal:session-open',
  calStreamSelect: 'cal:stream-select',
  calCommit: 'cal:commit',
  calReset: 'cal:reset',
  calSessionClose: 'cal:session-close',
  calCacheRead: 'cal:cache-read',
  calCacheStore: 'cal:cache-store',
  calCacheDrop: 'cal:cache-drop'
} as const
