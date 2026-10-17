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

// ── the calibration workflow (R3.1) ──────────────────────────────────────────
//
// The workflow runs in main (HidCalibrationService, calibration-workflow.ts). These are the shapes
// it pushes on `cal:workflow`: its own state, verbatim, and every value the HID tab and the dialog
// show that used to be decided in the renderer. The renderer only words and draws them.

/** Endpoints a user has captured or edited but not yet written. */
export interface DraftAxis extends CaptureResult {
  /** Whether this axis returns to rest. Defaults true; the user can override per axis. */
  selfCentring: boolean
  /**
   * The rest position as measured, kept even while a midpoint is in use.
   *
   * `centre` is the value that will be written, so switching to "no rest position" replaces it.
   * Without somewhere to keep the measurement, that switch is destructive and switching back
   * does not undo it: the user gets a midpoint that looks exactly as plausible as the rest
   * position they spent three sweeps capturing. Undefined when the capture never measured one.
   */
  capturedCentre?: number
}

export type WritePhase =
  /** Sending COMMIT for one axis. */
  | 'writing'
  /**
   * Re-reading after the ACK.
   *
   * A separate phase because an acknowledgement only means "received". The read-back is what
   * proves "stored", and the badges are driven from it rather than from what was sent.
   */
  | 'verifying'
  /**
   * Every axis stored, held on screen so the user can see it.
   *
   * The work is finished here — this phase exists only because the whole save takes a few
   * hundred milliseconds, and a result that vanishes as fast as it appeared is indistinguishable
   * from nothing having happened.
   */
  | 'done'

export interface WriteProgress {
  phase: WritePhase
  /** Axes queued for this save, in order. */
  queue: number[]
  /** Index within `queue` currently being written. */
  at: number
  /** Axes the device has confirmed storing, this save. */
  stored: number[]
}

/** The workflow's own state (the renderer's CalibrationController state before R3.1). */
export interface WorkflowState {
  open: boolean
  /** Axis the dialog is showing, and the one the device is streaming. */
  axis: number
  /** Latest snapshot the device confirmed. Badges and values come from here, never from drafts. */
  device?: CalSnapshot
  /** Per-axis edits not yet written. Survives switching axes. */
  drafts: Record<number, DraftAxis>
  /**
   * Whether each axis returns to rest, chosen by the user.
   *
   * Held separately from the drafts because the choice has to be made *before* capturing — it
   * decides whether the flow has a third point at all. Keying it to a draft would mean the first
   * capture on every axis ran the centre step regardless, and the setting only became reachable
   * once it was too late to matter. Defaults to true; see DraftAxis.selfCentring.
   */
  restPosition: Record<number, boolean>
  /**
   * Axis a STREAM_SELECT is in flight for, if any.
   *
   * `axis` does not move until the device acknowledges. Switching optimistically would leave us
   * filtering for an axis the gateway is not streaming — every sample dropped on `idx`, so the
   * readout and capture look dead — and retrying the same axis would early-return as a no-op.
   */
  switchingTo?: number
  /**
   * Whether a sample for the current axis has actually arrived since it was selected.
   *
   * The ACK proves the device accepted the selection; this proves data is flowing. Kept separate
   * and non-blocking because the node emits only on change: a steady axis may send nothing at
   * all, so gating the UI on it would read as a hang.
   */
  streaming: boolean
  /** Live capture for the axis on screen, absent when not capturing. */
  capture?: CaptureState
  /** Most recent sample for the streamed axis, for the live readout. */
  live?: { raw: number; cal: number }
  write?: WriteProgress
  /** Why the last operation failed. Cleared when the user acts again. */
  failure?: CalFailure & { axis?: number }
  /** Axes that did store before a failure stopped the queue — worth naming in the UI. */
  storedBeforeFailure?: number[]
  /**
   * A confirmation to hold on screen for a few seconds.
   *
   * Every one of these operations finishes in well under a second — a COMMIT plus a read-back is
   * two round trips against a 2 s timeout, and the erase is ~28 ms. Clearing the state the
   * instant the work is done means the only evidence anything happened is a flicker, which reads
   * as "nothing happened" rather than "done". Success needs to stay put long enough to be read.
   */
  notice?: { kind: 'written' | 'erased'; axes: number[] }
  /**
   * Axes the cache holds that the device has lost, and the copy itself.
   *
   * Present does not mean acted on. This is an *offer* — restoring automatically onto a board
   * whose calibration went missing would be right most of the time and catastrophic the rest,
   * because the one case that produces a missing calibration and a populated cache is also the
   * case where the board might have been swapped. Wrong endpoints fail open and stay invisible.
   */
  restorable?: { board: CachedBoard; axes: number[] }
  /** Whether the restore offer is expanded for review. Never restores without this. */
  restoreOpen: boolean
  /**
   * The serial link is closed, so nothing can reach the device (#74).
   *
   * Calibration rides on the serial port while the joystick does not, so the dialog can outlive
   * the link. Paused is not cancelled: drafts, accepted sweeps and the last snapshot are kept,
   * and the session is reopened when the same board comes back. Set from the moment the link
   * drops until that reopen is acknowledged — not merely until the link is up again.
   */
  paused: boolean
  busy: boolean
}

/** One axis row of a GET_CAL snapshot. */
export type CalAxis = CalSnapshot['axes'][number]

/** Per-axis stored-calibration state on the HID tab; an axis with neither has no badge. */
export type CalBadge = 'cal' | 'raw'

/** How much of the full range a captured travel spans. Descriptive, never an error. */
export interface TravelQuality {
  counts: number
  pct: number
  at: number
  label: 'Good' | 'Workable' | 'Low'
  tone: 'ok' | '' | 'warn'
}

/**
 * What the live prompt means during a capture; the dialog words it.
 *
 * `holding` is the split between the two states of each step (keep moving / stop moving). `side`
 * is the derived direction of the stop being asked for, null while there is no evidence either
 * way (and always null on the centre step).
 */
export interface CapturePrompt {
  step: CaptureStep
  holding: boolean
  side: 'upper' | 'lower' | null
  awaitingMovement: boolean
}

/** The dialog's sweep counter line. */
export type SweepCount =
  | { kind: 'capturing'; sweep: number; of: number }
  | { kind: 'captured'; of: number }
  | { kind: 'per-axis'; of: number }

/** The calibration dialog, decided: every gate and derived value it shows (§4.6). */
export interface CalibrationDialogState {
  /** The workflow's state, for the values the dialog displays. */
  workflow: WorkflowState
  /** Axes the device declares, for the rail. */
  present: CalAxis[]
  /** The axis on screen's unwritten edit. */
  draft?: DraftAxis
  /** What the device holds for the axis on screen. */
  stored?: CalAxis
  /** A write in progress; the held 'done' confirmation is not one. */
  writing: boolean
  /** An axis the device would refuse, and why. */
  invalid: { axis: number; reason: string } | null
  /** The footer names the refused axis (not while writing). */
  showInvalid: boolean
  /** Endpoints on show: the draft, else what the device stores. */
  shown?: CaptureResult
  travel: TravelQuality | null
  /** The axis on screen returns to rest. */
  selfCentring: boolean
  /** The live prompt, or null when none is shown (not capturing, or paused). */
  prompt: CapturePrompt | null
  /** Axes with edits, in index order: what Write would send. */
  dirty: number[]
  /** The step strip: shown once there is a capture or a draft. */
  strip: boolean
  /** Which of the two steps is current: 0 full travel, 1 review & write. */
  stepIndex: 0 | 1
  /** Sweeps left while the travel step is current. */
  sweepsRemaining?: number
  /** The "Hold at each stop" marker on the bar. */
  holdAtStops: boolean
  /** The dwell bar while a prompt is shown. */
  hold?: { remainingMs: number; progress: number }
  sweeps: SweepCount
  /** Accepted sweeps, each flagged when it falls short of the widest. */
  convergence: { min: number; max: number; short: boolean }[]
  /** The restore offer: expanded for review, folded to a re-offer line, or not shown. */
  restore: 'panel' | 'reoffer' | null
  /** The written/erased confirmation is shown. */
  notice: boolean
  /** Primary capture button: Redo after a rejected sweep, else Start / Re-capture. */
  capture: { action: 'redo' | 'start'; disabled: boolean; recapture: boolean }
  /** Disabled controls. */
  disabled: {
    /** ✕ and Cancel. */
    close: boolean
    /** The rail's axis buttons. */
    axisSwitch: boolean
    /** The rest-position toggle. */
    rest: boolean
    write: boolean
  }
  /** Delete calibration: shown, and whether it is greyed out. */
  remove: { shown: boolean; disabled: boolean }
}

/** The HID tab's calibration parts (§4.6). */
export interface CalibrationTabState {
  /**
   * What the attached device last reported, while the link is up.
   *
   * `undefined` means "not known" — no device, or a gateway whose firmware predates the
   * calibration protocol and never answers. That is deliberately distinct from "uncalibrated":
   * showing every axis as uncalibrated because we failed to ask would be a lie.
   */
  snapshot?: CalSnapshot
  /** Per axis index; absent = not declared (or not known), so no badge. */
  badges: Partial<Record<number, CalBadge>>
  /** Declared axes with no calibration on the device. */
  uncalibrated: number
  /** Axes the device lost that the cache holds a confirmed copy of. */
  offer?: { confirmedAt: string; axes: number[] }
  /** The restore banner is shown. */
  showOffer: boolean
  /** Review & restore opens on this axis. */
  offerAxis?: number
  /** The Calibrate button: shown, enabled, and the axis it opens on. */
  calibrate: { shown: boolean; enabled: boolean; axis?: number }
}

/** `cal:workflow`: the HID tab's calibration parts and, while it is shown, the dialog. */
export interface CalibrationState {
  tab: CalibrationTabState
  dialog?: CalibrationDialogState
}

/**
 * The state at launch, before main has pushed anything: no device report, the link down, no
 * dialog. The renderer starts from it; main's own first state is pinned equal to it.
 */
export const CALIBRATION_IDLE: CalibrationState = {
  tab: {
    badges: {},
    uncalibrated: 0,
    showOffer: false,
    calibrate: { shown: true, enabled: false }
  }
}

/** This topic's main -> renderer pushes; shared/app assembles them into `PushChannels`. */
export interface CalibrationPushChannels {
  'cal:workflow': CalibrationState
}

/** Push channel names (main -> renderer). */
export const CALIBRATION_PUSH = {
  calWorkflow: 'cal:workflow'
} as const

/**
 * Intent channel names (renderer -> main, invoke/response): the workflow's user actions, and
 * `cal:attach` — the HID tab mounting and unmounting, which is where the workflow's lifetime begins
 * and ends. The protocol exchanges they drive (HELLO, GET_CAL, SESSION_OPEN, …) and the cache are
 * main-internal.
 */
export const CALIBRATION_CTRL = {
  calOpen: 'cal:open',
  calClose: 'cal:close',
  calSelectAxis: 'cal:select-axis',
  calStartCapture: 'cal:start-capture',
  calRetry: 'cal:retry',
  calSetSelfCentring: 'cal:set-self-centring',
  calSave: 'cal:save',
  calRestore: 'cal:restore',
  calDeleteAxis: 'cal:delete-axis',
  calSetRestoreOpen: 'cal:set-restore-open',
  calAttach: 'cal:attach'
} as const
