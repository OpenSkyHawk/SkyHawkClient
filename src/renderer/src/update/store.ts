// The firmware update dialog as main pushes it (`update:state`, #173), and its intents. Main runs
// the update and decides every state; the dialog only words it. The IPC adapter binds the intents
// and delivers the pushes.
import { create } from 'zustand'
import type { SkyhawkApi } from '@shared/app'
import type { UpdateState, UpdateTargetRef } from '@shared/update'

export interface UpdateStoreState {
  /** What main pushed last; null while no update is open. */
  update: UpdateState | null
  openUpdate: (target: UpdateTargetRef) => void
  ackUpdate: (on: boolean) => void
  startUpdate: () => void
  retryUpdate: () => void
  closeUpdate: () => void
}

/** Main, as the IPC adapter hands it over; nothing until it binds. */
let api: () => SkyhawkApi | undefined = () => undefined

/** The IPC adapter's binding: every intent reads `window.skyhawk` through it, at call time. */
export function bindUpdate(skyhawk: () => SkyhawkApi | undefined): void {
  api = skyhawk
}

export const useUpdateStore = create<UpdateStoreState>(() => ({
  update: null,
  openUpdate: (target) => void api()?.updateOpen(target),
  ackUpdate: (on) => void api()?.updateAck(on),
  startUpdate: () => void api()?.updateStart(),
  retryUpdate: () => void api()?.updateRetry(),
  closeUpdate: () => void api()?.updateClose()
}))

/** What main sends this slice; the IPC adapter calls each as its push or pull lands. */
export const updateFromMain = {
  /** `update:state`, and `update:get`'s answer. */
  state: (update: UpdateState | null): void => useUpdateStore.setState({ update })
}
