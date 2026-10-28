// The firmware release check and the releases saved on this computer, as main pushes them
// (`releases:state`, #192), and their two intents: *Check now* and *Clear*. Main decides every
// state; the views only word it. The IPC adapter binds the intents and delivers the pushes.
import { create } from 'zustand'
import type { SkyhawkApi } from '@shared/app'
import { RELEASES_STATE_DEFAULT, type ReleasesState } from '@shared/releases'

export interface ReleasesStoreState {
  /** What main pushed last. */
  releases: ReleasesState
  /** *Check now*: main joins a check already running and pushes as it goes. */
  checkReleases: () => void
  /** *Clear*: main removes every saved release (refused while an update reads one). */
  clearReleases: () => void
}

/** Main, as the IPC adapter hands it over; nothing until it binds. */
let api: () => SkyhawkApi | undefined = () => undefined

/** The IPC adapter's binding: every intent reads `window.skyhawk` through it, at call time. */
export function bindReleases(skyhawk: () => SkyhawkApi | undefined): void {
  api = skyhawk
}

export const useReleasesStore = create<ReleasesStoreState>(() => ({
  releases: RELEASES_STATE_DEFAULT,
  checkReleases: () => void api()?.checkReleases(),
  clearReleases: () => void api()?.clearReleases()
}))

/** What main sends this slice; the IPC adapter calls each as its push or pull lands. */
export const releasesFromMain = {
  /** `releases:state`, and `releases:get`'s answer. */
  state: (releases: ReleasesState): void => useReleasesStore.setState({ releases })
}
