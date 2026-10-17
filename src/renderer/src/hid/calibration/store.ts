// Axis calibration as main pushes it, and the dialog's intents (R3.4b: the calibration slice of the
// old single store, cut verbatim). The IPC adapter binds the intents and delivers the pushes.
import { create } from 'zustand'
import type { SkyhawkApi } from '@shared/app'
import { CALIBRATION_IDLE, type CalibrationState } from '@shared/hid/calibration'

export interface CalibrationStoreState {
  /**
   * Axis calibration as main pushes it (`cal:workflow`): the device's stored calibration and the
   * HID tab's badges and offer, and the calibration dialog while it is open. Main runs the
   * workflow; the HID tab and the dialog only render this and send `calibrate` intents.
   */
  calibration: CalibrationState
  /** The calibration dialog's actions, sent to main. */
  calibrate: CalibrationIntents
}

/** The calibration dialog's actions (R3.1): main runs the workflow and pushes `cal:workflow`. */
export interface CalibrationIntents {
  /** Open the dialog on `axis`; `review` expands the restore offer. */
  open(axis: number, review?: boolean): void
  close(): void
  selectAxis(axis: number): void
  startCapture(): void
  retry(): void
  setSelfCentring(selfCentring: boolean): void
  save(): void
  restore(): void
  deleteAxis(idx: number): void
  setRestoreOpen(open: boolean): void
  /** The HID tab mounted (`true`) or unmounted (`false`). */
  attach(on: boolean): void
}

/** Main, as the IPC adapter hands it over; nothing until it binds. */
let skyhawk: () => SkyhawkApi | undefined = () => undefined

/** The IPC adapter's binding: every intent reads `window.skyhawk` through it, at call time. */
export function bindCalibration(ref: () => SkyhawkApi | undefined): void {
  skyhawk = ref
}

/** The calibration intents, each a call to main. */
function calibrationIntents(): CalibrationIntents {
  const api = () => skyhawk()
  return {
    open: (axis, review) => void api()?.calOpen(axis, review),
    close: () => void api()?.calClose(),
    selectAxis: (axis) => void api()?.calSelectAxis(axis),
    startCapture: () => void api()?.calStartCapture(),
    retry: () => void api()?.calRetry(),
    setSelfCentring: (selfCentring) => void api()?.calSetSelfCentring(selfCentring),
    save: () => void api()?.calSave(),
    restore: () => void api()?.calRestore(),
    deleteAxis: (idx) => void api()?.calDeleteAxis(idx),
    setRestoreOpen: (open) => void api()?.calSetRestoreOpen(open),
    attach: (on) => void api()?.calAttach(on)
  }
}

export const useCalibrationStore = create<CalibrationStoreState>(() => ({
  calibration: CALIBRATION_IDLE,
  calibrate: calibrationIntents()
}))

/** What main sends this slice; the IPC adapter calls each as its push or pull lands. */
export const calibrationFromMain = {
  /**
   * The rehydrate bundle's `cal`. The device's report is only pushed when the port opens. A
   * renderer reload builds a fresh store while the main-process session keeps running, so without
   * carrying the calibration here the badges would stay blank until the next reconnect — forever,
   * on a stable link.
   */
  status: (cal: CalibrationState | undefined): void =>
    useCalibrationStore.setState({ calibration: cal ?? CALIBRATION_IDLE }),

  /** `cal:workflow`. */
  workflow: (c: CalibrationState): void => useCalibrationStore.setState({ calibration: c })
}
