// update's intents: the update dialog's actions (#173). app/ipc.ts registers them.
import type { IpcRegistrar } from '@shared/app'
import { UPDATE_CTRL, type UpdateTargetRef } from '@shared/update'
import type { UpdateHost } from './update-host'

export interface UpdateIpcDeps {
  update: UpdateHost
}

export function registerUpdateIpc(ipc: IpcRegistrar, deps: UpdateIpcDeps): void {
  const { update } = deps
  ipc.handle(UPDATE_CTRL.updateGet, () => update.state())
  ipc.handle(UPDATE_CTRL.updateOpen, (_e, target) => update.openUpdate(target as UpdateTargetRef))
  ipc.handle(UPDATE_CTRL.updateAck, (_e, on) => update.ack(on === true))
  // Main pushes `update:state` as the run goes; the answer is only that it has ended.
  ipc.handle(UPDATE_CTRL.updateStart, () => update.start())
  ipc.handle(UPDATE_CTRL.updateRetry, () => update.retry())
  ipc.handle(UPDATE_CTRL.updateClose, () => update.close())
}
