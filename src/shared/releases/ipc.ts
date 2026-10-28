// Releases topic contract (#192): the firmware release check and the releases kept on this
// computer, as main pushes them. Imported by main, preload and the renderer.
//
// Versions travel as `x.y.z` text (the manifest's `version`), never as the release tag; dates and
// times as ms since the epoch. Main decides every state; the renderer only words it.

/** A firmware release on GitHub: its version and when it was published. */
export interface ReleaseInfo {
  version: string
  /** GitHub's `published_at`. */
  date: number
}

/** What the release check is doing now, or how its last run ended. */
export type ReleaseCheck =
  /** No check has reached GitHub yet (the setting is off, or the first run). */
  | { kind: 'never' }
  /** Asking GitHub; a second request joins this one. */
  | { kind: 'checking' }
  /** The latest release is being downloaded and saved. */
  | { kind: 'downloading'; version: string }
  /** The last check is good: `latest` is saved, or nothing newer was found. */
  | { kind: 'ok' }
  /** GitHub has no firmware release this client can use (none at or above the minimum). */
  | { kind: 'no-release' }
  /** GitHub couldn't be reached, or didn't answer in time. */
  | { kind: 'offline' }
  /** GitHub's limit for unauthenticated checks was reached; it resets at `retryAt`. */
  | { kind: 'rate-limited'; retryAt: number }
  /** The download was cut off, didn't match its checksum, or held a refused name. */
  | { kind: 'download-failed'; version: string }
  /** Not enough space to save the release: `neededBytes` is the zip plus what it unpacks to. */
  | { kind: 'disk-full'; version: string; neededBytes: number }
  /** The release couldn't be written for another reason (a folder that isn't writable, …). */
  | { kind: 'not-saved'; version: string }

/** The last check that reached GitHub. Kept in <userData>/release-check.json across launches. */
export interface LastCheck {
  checkedAt: number
  /** The highest release on a major this client supports; absent when none was found. */
  latest?: ReleaseInfo
  /** A release on a newer major than this client supports: reported, never downloaded. */
  newerMajor?: ReleaseInfo
}

/** One release saved on this computer. */
export interface CachedVersion {
  version: string
  /** When the release was published; absent for a folder saved without it. */
  date?: number
  /** Its size on disk. */
  bytes: number
}

/** `releases:state`: everything the firmware-update surfaces show about releases. */
export interface ReleasesState {
  check: ReleaseCheck
  last?: LastCheck
  /** The saved releases, newest first. These are the versions an update can install. */
  cached: CachedVersion[]
  /** Every saved release's size on disk, together. */
  cachedBytes: number
  /**
   * The saved releases were removed (*Clear*, or every folder dropped at start) and nothing has
   * been saved since: the next check downloads the latest again.
   */
  emptied: boolean
  /** *Clear* can run: something is saved and no update is reading a file. */
  canClear: boolean
}

/** What the renderer shows before main has said anything. */
export const RELEASES_STATE_DEFAULT: ReleasesState = {
  check: { kind: 'never' },
  cached: [],
  cachedBytes: 0,
  emptied: false,
  canClear: false
}

/** This topic's main -> renderer pushes; shared/app assembles them into `PushChannels`. */
export interface ReleasesPushChannels {
  /** The release check and the saved releases, after every change. */
  'releases:state': ReleasesState
}

/** Push channel names (main -> renderer). */
export const RELEASES_PUSH = {
  releasesState: 'releases:state'
} as const

/** Intent channel names (renderer -> main, invoke/response). */
export const RELEASES_CTRL = {
  releasesGet: 'releases:get',
  releasesCheck: 'releases:check',
  releasesClear: 'releases:clear'
} as const
