// What the HID tab and the calibration dialog show, decided from the workflow's state (R3.1). Each
// derivation is the one the renderer made before the workflow moved to main (the dialog and the
// HID tab), kept verbatim; the renderer now only words and draws the result.
import { HID_REPORT_LAYOUT } from '@shared/firmware'
import type {
  CalBadge,
  CalibrationDialogState,
  CalibrationTabState,
  CalSnapshot,
  CapturePrompt,
  TravelQuality,
  WorkflowState
} from '@shared/hid/calibration'
import {
  DEFAULT_CAPTURE_CONFIG,
  hasTravelled,
  holdProgress,
  holdRemainingMs,
  sweepsRemaining
} from './axis-capture'

/** 65535: the full unsigned span, from the HID report's axis range. */
const AXIS_SPAN = HID_REPORT_LAYOUT.axes.max - HID_REPORT_LAYOUT.axes.min

/** Descriptive, never an error: 40% is the expected healthy result for a short-arc axis. */
const TRAVEL_BANDS = [
  { at: 0.6, label: 'Good', tone: 'ok' },
  { at: 0.3, label: 'Workable', tone: '' },
  { at: 0, label: 'Low', tone: 'warn' }
] as const

function travelQuality(min?: number, max?: number): TravelQuality | null {
  if (min === undefined || max === undefined) return null
  const counts = max - min
  const band = TRAVEL_BANDS.find((b) => counts / AXIS_SPAN >= b.at)!
  return { counts, pct: Math.round((counts / AXIS_SPAN) * 100), ...band }
}

/**
 * The live prompt during a capture: what it asks for, not how it is worded.
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
function prompt(s: WorkflowState, startRaw: number | null): CapturePrompt | null {
  const cap = s.capture
  if (!cap || cap.phase !== 'capturing') return null
  const holding = hasTravelled(cap)
  const dir = (v: number) => (startRaw === null || v >= startRaw ? 'upper' : 'lower')

  if (cap.step === 'centre') {
    return { step: 'centre', holding, side: null, awaitingMovement: cap.awaitingMovement }
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

  return { step: cap.step, holding, side, awaitingMovement: cap.awaitingMovement }
}

/** What the workflow answers for the axis on screen (its own methods). */
export interface WorkflowAnswers {
  invalid: { axis: number; reason: string } | null
  selfCentring: boolean
  dirty: number[]
  /** Where the axis sat when capture opened — the only honest anchor for "upper"/"lower". */
  startRaw: number | null
}

/** The dialog's gates and derived values (CalibrationDialog.tsx before R3.1). */
export function dialogState(s: WorkflowState, a: WorkflowAnswers): CalibrationDialogState {
  const present = s.device?.axes.filter((x) => x.present) ?? []
  const draft = s.drafts[s.axis]
  const stored = s.device?.axes[s.axis]
  const cap = s.capture
  // 'done' is the held confirmation, not work in progress. Treating it as writing left the
  // footer reading "Writing…" beside a strip saying the device had already confirmed the write,
  // and kept Cancel and Delete disabled for three seconds after there was anything to wait for.
  const writing = !!s.write && s.write.phase !== 'done'
  const invalid = a.invalid
  const shown = draft ?? (stored?.calibrated ? stored : undefined)
  const travel = travelQuality(shown?.min, shown?.max)
  // A paused capture is frozen, so "push it to its stop" would ask for movement nothing records.
  const p = s.paused ? null : prompt(s, a.startRaw)
  const dirty = a.dirty
  // A rejected sweep is still step 1: nothing was captured, and Redo continues the same capture.
  const inTravel = cap?.phase === 'capturing' || cap?.phase === 'rejected'
  const recapture = !!(draft || stored?.calibrated)

  return {
    workflow: s,
    present,
    draft,
    stored,
    writing,
    invalid,
    showInvalid: !!invalid && !writing,
    shown,
    travel,
    selfCentring: a.selfCentring,
    prompt: p,
    dirty,
    strip: !!(cap || draft),
    stepIndex: inTravel ? 0 : 1,
    sweepsRemaining: inTravel && cap ? sweepsRemaining(cap) : undefined,
    holdAtStops: cap?.phase === 'capturing' && !cap.awaitingMovement,
    hold: p && cap ? { remainingMs: holdRemainingMs(cap), progress: holdProgress(cap) } : undefined,
    sweeps:
      cap?.phase === 'capturing'
        ? { kind: 'capturing', sweep: cap.accepted.length + 1, of: cap.config.sweepsRequired }
        : draft
          ? { kind: 'captured', of: DEFAULT_CAPTURE_CONFIG.sweepsRequired }
          : { kind: 'per-axis', of: DEFAULT_CAPTURE_CONFIG.sweepsRequired },
    convergence:
      cap && cap.accepted.length > 0
        ? cap.accepted.map((w) => {
            // Accepted sweeps are within slack by construction, so this flags the ones that
            // still contribute nothing under widest-wins rather than reporting a fault.
            const widest = Math.max(...cap.accepted.map((x) => x.max - x.min))
            const short = widest - (w.max - w.min) > widest * cap.config.shortfallFraction
            return { min: w.min, max: w.max, short }
          })
        : [],
    restore: s.restorable && !s.write && !s.paused ? (s.restoreOpen ? 'panel' : 'reoffer') : null,
    notice: !!s.notice && !s.write,
    capture:
      cap?.phase === 'rejected'
        ? { action: 'redo', disabled: s.paused, recapture }
        : {
            action: 'start',
            disabled: writing || cap?.phase === 'capturing' || s.paused,
            recapture
          },
    disabled: {
      close: writing,
      axisSwitch: writing || s.switchingTo !== undefined,
      rest: writing || cap?.phase === 'capturing',
      write: writing || !dirty.length || !!invalid || s.paused
    },
    remove: { shown: !!stored?.calibrated && !writing, disabled: s.paused }
  }
}

/** The HID tab's calibration parts (the renderer's before R3.1). */
export function tabState(
  snapshot: CalSnapshot | undefined,
  linkUp: boolean,
  offer: { confirmedAt: string; axes: number[] } | undefined
): CalibrationTabState {
  const present = snapshot ? snapshot.axes.filter((a) => a.present) : []
  const uncalibrated = present.filter((a) => !a.calibrated).length
  // Calibration is a property of the attached device, so badges follow presentMask alone.
  const badges: Partial<Record<number, CalBadge>> = {}
  snapshot?.axes.forEach((a, i) => {
    if (a?.present) badges[i] = a.calibrated ? 'cal' : 'raw'
  })
  return {
    snapshot,
    badges,
    uncalibrated,
    offer,
    showOffer: !!offer && linkUp && present.length > 0,
    offerAxis: offer?.axes[0],
    calibrate: {
      shown: present.length > 0 || !linkUp,
      enabled: linkUp,
      axis: present.find((a) => !a.calibrated)?.idx ?? present[0]?.idx
    }
  }
}
