// releases' intents: the state pulled on load, *Check now* and *Clear*. app/ipc.ts registers them.
import type { IpcRegistrar } from '@shared/app'
import { RELEASES_CTRL } from '@shared/releases'
import type { Releases } from './releases'

export interface ReleasesIpcDeps {
  releases: Releases
}

export function registerReleasesIpc(ipc: IpcRegistrar, deps: ReleasesIpcDeps): void {
  const { releases } = deps
  ipc.handle(RELEASES_CTRL.releasesGet, () => releases.state())
  // Main pushes `releases:state` as the check runs; the answer is only that it has ended.
  ipc.handle(RELEASES_CTRL.releasesCheck, async () => {
    await releases.checkNow()
  })
  ipc.handle(RELEASES_CTRL.releasesClear, async () => {
    await releases.clear()
  })
}
