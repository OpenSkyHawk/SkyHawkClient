// hid/calibration's intents: axis calibration (#46). app/ipc.ts registers them.
import type { IpcRegistrar } from '@shared/app'
import { CALIBRATION_CTRL, type CalCacheEntry, type CalCommitAxis } from '@shared/hid/calibration'
import type { HidCalibrationService } from './hid-calibration-service'

export interface CalibrationIpcDeps {
  calibration: HidCalibrationService
}

export function registerCalibrationIpc(ipc: IpcRegistrar, deps: CalibrationIpcDeps): void {
  const { calibration } = deps
  // Axis calibration (#46). Every one returns a discriminated CalResult rather than throwing:
  // an ipcRenderer.invoke rejection flattens to a plain Error, which would lose the
  // timeout-vs-nack distinction the UI's failure messaging depends on.
  ipc.handle(CALIBRATION_CTRL.calHello, () => calibration.calHello())
  ipc.handle(CALIBRATION_CTRL.calRead, () => calibration.calRead())
  ipc.handle(CALIBRATION_CTRL.calSessionOpen, (_e, axisIdx: number) =>
    calibration.calSessionOpen(axisIdx)
  )
  ipc.handle(CALIBRATION_CTRL.calStreamSelect, (_e, axisIdx: number) =>
    calibration.calStreamSelect(axisIdx)
  )
  ipc.handle(CALIBRATION_CTRL.calCommit, (_e, axis: CalCommitAxis) => calibration.calCommit(axis))
  ipc.handle(CALIBRATION_CTRL.calReset, (_e, idx: number) => calibration.calReset(idx))
  ipc.handle(CALIBRATION_CTRL.calCacheRead, () => calibration.calCacheRead())
  ipc.handle(CALIBRATION_CTRL.calCacheStore, (_e, axes: CalCacheEntry[]) =>
    calibration.calCacheStore(axes)
  )
  ipc.handle(CALIBRATION_CTRL.calCacheDrop, (_e, idx: number) => calibration.calCacheDrop(idx))
  ipc.handle(CALIBRATION_CTRL.calSessionClose, () => calibration.calSessionClose())
}
