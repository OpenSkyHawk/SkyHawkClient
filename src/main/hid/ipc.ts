// hid's intent: which report indices the firmware catalogues. app/ipc.ts registers it.
import type { IpcRegistrar } from '@shared/app'
import { HID_CTRL } from '@shared/hid'
import { hidAvailability } from './hid-report'

export function registerHidIpc(ipc: IpcRegistrar): void {
  ipc.handle(HID_CTRL.hidAvailability, () => hidAvailability())
}
