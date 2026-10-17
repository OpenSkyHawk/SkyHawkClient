// The calibration dialog's wording and geometry (R3.1). Main decides what is shown (the pushed
// CalibrationState); this only turns it into numbers on screen and the prompt's words.
import { HID_REPORT_LAYOUT } from '@shared/firmware'
import type { CapturePrompt } from '@shared/hid/calibration'

/** 32768: the unsigned -> signed offset, from the HID report's axis range. */
export const AXIS_OFFSET = -HID_REPORT_LAYOUT.axes.min
/** 65535: the full unsigned span, from the HID report's axis range. */
export const AXIS_SPAN = HID_REPORT_LAYOUT.axes.max - HID_REPORT_LAYOUT.axes.min

/**
 * Display units: signed ±32767, matching what DCS shows and what the HID tab reads off the
 * report. The wire, storage, capture and COMMIT all stay unsigned 0–65535 — that is the device's
 * language — so this is the single place the two meet.
 *
 * **Display only. Never call this on a value being committed.** The offset applied twice, or
 * zero times, still yields plausible in-range numbers and fails silently.
 */
const toDisplay = (unsigned: number) => unsigned - AXIS_OFFSET
export const fmt = (n: number) => toDisplay(n).toLocaleString('en-US')
/** A span, not a position — no offset applies. */
export const fmtSpan = (n: number) => n.toLocaleString('en-US')
export const pct = (v: number) => Math.max(0, Math.min(100, (v / AXIS_SPAN) * 100)).toFixed(2) + '%'

/**
 * The live prompt's words, from what main says it asks for.
 *
 * Two states per step: **travelling** (gold — keep moving, the bar is not counting yet) and
 * **holding** (green — stop moving, the bar is the dwell timer). Before the axis has moved at all
 * in the first step there is no direction, so the copy stays neutral.
 */
export function promptText(p: CapturePrompt) {
  const { holding, side } = p

  if (p.step === 'centre') {
    return {
      arrow: holding ? '■' : '↓',
      text: holding ? 'Let it settle — hands off' : 'Release the axis and let it return to rest',
      note: holding
        ? 'The axis is settled, so the device has stopped reporting. That is normal — the dwell timer runs on the clock.'
        : 'Take your hand off it completely; a hand resting on the axis is a held position.',
      holding
    }
  }

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
      : p.step === 'stopA'
        ? `Push the axis to its ${side.toUpperCase()} stop`
        : `Now ${side === 'lower' ? 'pull' : 'push'} it to its ${side.toUpperCase()} stop`,
    note: p.awaitingMovement
      ? 'Nothing has moved yet — take the axis all the way to the mechanical stop.'
      : 'Keep moving steadily until you reach the stop.',
    holding
  }
}
