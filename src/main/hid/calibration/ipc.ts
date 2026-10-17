// hid/calibration's intents: the calibration dialog's actions (#46). app/ipc.ts registers them.
// The protocol exchanges they drive are main-internal (HidCalibrationService); main answers each
// action by pushing `cal:workflow`.
import type { IpcRegistrar } from '@shared/app'
import { CALIBRATION_CTRL } from '@shared/hid/calibration'
import type { HidCalibrationService } from './hid-calibration-service'

export interface CalibrationIpcDeps {
  calibration: HidCalibrationService
}

export function registerCalibrationIpc(ipc: IpcRegistrar, deps: CalibrationIpcDeps): void {
  const { workflow } = deps.calibration
  ipc.handle(CALIBRATION_CTRL.calOpen, (_e, axis: number, review?: boolean) =>
    workflow.open(axis, review)
  )
  ipc.handle(CALIBRATION_CTRL.calClose, () => workflow.close())
  ipc.handle(CALIBRATION_CTRL.calSelectAxis, (_e, axis: number) => workflow.selectAxis(axis))
  ipc.handle(CALIBRATION_CTRL.calStartCapture, () => workflow.startCapture())
  ipc.handle(CALIBRATION_CTRL.calRetry, () => workflow.retry())
  ipc.handle(CALIBRATION_CTRL.calSetSelfCentring, (_e, selfCentring: boolean) =>
    workflow.setSelfCentring(selfCentring)
  )
  ipc.handle(CALIBRATION_CTRL.calSave, () => workflow.save())
  ipc.handle(CALIBRATION_CTRL.calRestore, () => workflow.restore())
  ipc.handle(CALIBRATION_CTRL.calDeleteAxis, (_e, idx: number) => workflow.deleteAxis(idx))
  ipc.handle(CALIBRATION_CTRL.calSetRestoreOpen, (_e, open: boolean) =>
    workflow.setRestoreOpen(open)
  )
  // The HID tab's mount and unmount: the workflow's lifetime (useCalibration's, before R3.1).
  ipc.handle(CALIBRATION_CTRL.calAttach, (_e, on: boolean) => workflow.attach(on))
}
