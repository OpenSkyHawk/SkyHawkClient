// The firmware release check and the releases saved on this computer (#192): the one owner of the
// release package. It checks GitHub on launch (when the setting is on) and on *Check now*,
// downloads the latest release this client can use when it is newer than the newest saved one,
// keeps the newest 5, and serves the update flows (#173, #187, #175, #177) their images through
// `getFile`. They never touch the zip, the manifest, a download or a SHA-256.
//
// It pushes `releases:state` after every change. The check runs one at a time: a second request
// joins the one running.
import type { Emit } from '@shared/app'
import type { FirmwareVersion } from '@shared/gateway'
import type {
  CachedVersion,
  LastCheck,
  ReleaseCheck,
  ReleaseInfo,
  ReleasesPushChannels,
  ReleasesState
} from '@shared/releases'
import { FetchFailed, GitHub, RateLimited, type FetchPort } from './github'
import {
  ReleaseCache,
  releaseTag,
  sha256,
  type CacheFs,
  type InstallResult,
  type ReleaseEvents
} from './release-cache'
import {
  assetUrl,
  compareVersions,
  imageErrorText,
  MANIFEST_ASSET,
  parseVersion,
  pickReleases,
  readManifest,
  readReleaseList,
  RELEASES_API,
  type ImageErrorKind,
  type ImageSelector,
  type ListedRelease,
  type ManifestFile,
  type ReleaseManifest
} from './release-rules'

/**
 * Port: <userData>/release-check.json, the last check that reached GitHub (app wires the JSON
 * store). `read` reports what it found; `write` returns the failure when the file didn't reach
 * the disk.
 */
export interface CheckFileIO {
  read():
    | { kind: 'read'; data: unknown }
    | { kind: 'missing' }
    | { kind: 'fallback'; data: unknown; note: string }
    | { kind: 'failed'; note: string }
  write(last: LastCheck): { error: unknown; note: string } | undefined
}

export interface ReleasesDeps {
  fetch: FetchPort
  /** Sent on every request: GitHub requires a User-Agent. */
  userAgent: () => string
  /** <userData>/firmware. */
  dir: () => string
  checkFile: CheckFileIO
  events: ReleaseEvents
  /** A release on a newer major than this client supports (gateway's rule, injected by app). */
  newerThanClient: (v: FirmwareVersion) => boolean
  /** Where a caller bug (an ambiguous selector) is logged. */
  log: (tag: string, data?: unknown) => void
  fs?: CacheFs
}

/** The event-log name of the check's own rows (its file). */
const CHECK_FILE_TAG = 'release-check.json'

/** Where an image comes from. #177's *From file…* adds `{ kind: 'file', … }` as a second kind. */
export type ImageSourceRef = { kind: 'release'; version: string }

/** An image's manifest entry, as an update reads it. */
export type ImageEntry = Omit<ManifestFile, 'path'>

/** A typed error, with the words an update dialog shows for it. */
export interface ImageError {
  ok: false
  error: ImageErrorKind
  message: string
}

export type GetFileResult =
  | { ok: true; bytes: Uint8Array; entry: ImageEntry; source: ImageSourceRef }
  | ImageError

export type ImageForResult = { ok: true; entry: ImageEntry } | ImageError

/** One kind of image source: the lookup behind `getFile`. */
interface ImageSource<S extends ImageSourceRef> {
  get(source: S, sel: ImageSelector): Promise<GetFileResult>
}

/** What a download came to, in the check's terms. */
type Saved =
  | { ok: true }
  | { ok: false; check: Extract<ReleaseCheck, { version: string }>; unreachable: boolean }

const entryOf = ({ path: _path, ...entry }: ManifestFile): ImageEntry => entry

const info = (r: ListedRelease): ReleaseInfo => ({ version: r.version, date: r.date })

function readInfo(raw: unknown): ReleaseInfo | undefined {
  const r = raw as Partial<ReleaseInfo> | undefined
  if (!r || typeof r.version !== 'string' || !parseVersion(r.version)) return undefined
  return typeof r.date === 'number' ? { version: r.version, date: r.date } : undefined
}

/** release-check.json, read back: anything that isn't a last check is none. */
export function readLastCheck(raw: unknown): LastCheck | undefined {
  const r = raw as Partial<LastCheck> | undefined
  if (!r || typeof r !== 'object' || typeof r.checkedAt !== 'number') return undefined
  const latest = readInfo(r.latest)
  const newerMajor = readInfo(r.newerMajor)
  return { checkedAt: r.checkedAt, ...(latest && { latest }), ...(newerMajor && { newerMajor }) }
}

export class Releases {
  private readonly cache: ReleaseCache
  private readonly github: GitHub
  private check: ReleaseCheck = { kind: 'never' }
  private last?: LastCheck
  private emptied = false
  private running?: Promise<void>
  /** The start scan: a check waits for it, so it never re-downloads a version already saved. */
  private scanned: Promise<unknown> = Promise.resolve()
  /** A repair per version in progress: a second read of a damaged file joins it. */
  private readonly repairs = new Map<string, Promise<InstallResult | 'unreachable'>>()
  private readonly sources: { [K in ImageSourceRef['kind']]: ImageSource<ImageSourceRef> }

  constructor(
    private readonly emit: Emit<keyof ReleasesPushChannels>,
    private readonly deps: ReleasesDeps
  ) {
    this.cache = new ReleaseCache({ dir: deps.dir, events: deps.events, fs: deps.fs })
    this.github = new GitHub(deps.fetch, deps.userAgent)
    this.sources = { release: { get: (source, sel) => this.fromRelease(source, sel) } }
  }

  // ── launch ─────────────────────────────────────────────────────────────────

  /**
   * App launch: the last check back from release-check.json, the saved releases scanned, then a
   * check if *Check for updates on launch* is on. Resolves once that check is done.
   */
  async open(checkOnLaunch: boolean): Promise<void> {
    this.last = this.loadLastCheck()
    if (this.last) this.check = this.last.latest ? { kind: 'ok' } : { kind: 'no-release' }
    const scan = this.cache.scan()
    this.scanned = scan
    const { droppedAll } = await scan
    if (droppedAll) this.emptied = true
    this.push()
    if (checkOnLaunch) await this.checkNow()
  }

  private loadLastCheck(): LastCheck | undefined {
    try {
      const r = this.deps.checkFile.read()
      switch (r.kind) {
        case 'read':
          return readLastCheck(r.data)
        case 'fallback':
          this.deps.events.warn(CHECK_FILE_TAG, r.note)
          return readLastCheck(r.data)
        case 'failed':
          this.deps.events.error(CHECK_FILE_TAG, `${r.note} Starting with no earlier check.`)
          return undefined
        case 'missing':
          return undefined
      }
    } catch {
      return undefined // the path could not be resolved
    }
  }

  // ── the state ──────────────────────────────────────────────────────────────

  /** `releases:state` (and `releases:get`'s answer). */
  state(): ReleasesState {
    const cached = this.cache.list()
    return {
      check: this.check,
      ...(this.last && { last: this.last }),
      cached,
      cachedBytes: cached.reduce((n, c) => n + c.bytes, 0),
      emptied: this.emptied && cached.length === 0,
      canClear: cached.length > 0 && !this.cache.busy()
    }
  }

  private push(): void {
    this.emit('releases:state', this.state())
  }

  private setCheck(check: ReleaseCheck): void {
    this.check = check
    this.push()
  }

  /** The latest release this client can use, as the last check found it. */
  latest(): ReleaseInfo | undefined {
    return this.last?.latest
  }

  /** What the check is doing, the last check, and a newer major it reported (never downloaded). */
  checkState(): { check: ReleaseCheck; last?: LastCheck; newerMajor?: ReleaseInfo } {
    return {
      check: this.check,
      ...(this.last && { last: this.last }),
      ...(this.last?.newerMajor && { newerMajor: this.last.newerMajor })
    }
  }

  /** The saved releases, newest first: the versions an update can install, online or not. */
  cachedVersions(): CachedVersion[] {
    return this.cache.list()
  }

  // ── the check ──────────────────────────────────────────────────────────────

  /** Launch or *Check now*: one check at a time; a second request joins the one running. */
  checkNow(): Promise<void> {
    this.running ??= this.run().finally(() => (this.running = undefined))
    return this.running
  }

  private async run(): Promise<void> {
    this.setCheck({ kind: 'checking' })
    let raw: unknown
    try {
      raw = await this.github.releases(RELEASES_API)
    } catch (err) {
      return this.setCheck(
        err instanceof RateLimited
          ? { kind: 'rate-limited', retryAt: err.retryAt }
          : { kind: 'offline' }
      )
    }
    const checkedAt = Date.now()
    const pick = pickReleases(readReleaseList(raw), this.deps.newerThanClient)
    await this.scanned
    const newest = this.cache.newest()

    // The highest candidate wins. One no newer than the newest saved costs no asset request; a
    // newer one needs its manifest first — none yet (still uploading) is skipped quietly, a bad
    // one is skipped with a warn row.
    let latest: ListedRelease | undefined
    let download: { release: ListedRelease; manifest: ReleaseManifest; text: string } | undefined
    for (const release of pick.candidates) {
      if (newest && compareVersions(release.version, newest) <= 0) {
        latest = release
        break
      }
      const m = await this.manifestOf(release)
      if (m === 'unreachable') return this.setCheck({ kind: 'offline' })
      if (m === 'none') continue
      if (!m.ok) {
        this.deps.events.warn(
          releaseTag(release.version),
          `Firmware ${release.version} was skipped: its manifest.json can’t be used (${m.reason}).`
        )
        continue
      }
      latest = release
      download = { release, manifest: m.manifest, text: m.text }
      break
    }

    this.last = {
      checkedAt,
      ...(latest && { latest: info(latest) }),
      ...(pick.newerMajor && { newerMajor: info(pick.newerMajor) })
    }
    const failed = this.deps.checkFile.write(this.last)
    if (failed) this.deps.events.error(CHECK_FILE_TAG, failed.note)
    if (!latest) return this.setCheck({ kind: 'no-release' })
    if (!download) return this.setCheck({ kind: 'ok' })

    this.setCheck({ kind: 'downloading', version: download.release.version })
    const saved = await this.save(download.manifest, download.text, download.release.date, {
      url: download.release.assets.get(download.manifest.zip.name)?.url
    })
    this.setCheck(saved.ok ? { kind: 'ok' } : saved.check)
  }

  /** A release's flat manifest: read, refused with why, none on the release yet, or unreachable. */
  private async manifestOf(
    release: ListedRelease
  ): Promise<
    | { ok: true; manifest: ReleaseManifest; text: string }
    | { ok: false; reason: string }
    | 'none'
    | 'unreachable'
  > {
    const asset = release.assets.get(MANIFEST_ASSET)
    if (!asset) return 'none'
    let text: string
    try {
      text = await this.github.text(asset.url)
    } catch (err) {
      return err instanceof FetchFailed && err.status === 404 ? 'none' : 'unreachable'
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return { ok: false, reason: 'it does not parse' }
    }
    const read = readManifest(raw, { version: release.version, tag: release.tag })
    return read.ok
      ? { ok: true, manifest: read.manifest, text }
      : { ok: false, reason: read.reason }
  }

  /**
   * Download a release's zip, check it against the manifest's zip record (name, size, SHA-256),
   * and put the version in place. Each failure is one error row; a version that lands forgets
   * its earlier ones.
   */
  private async save(
    manifest: ReleaseManifest,
    text: string,
    publishedAt: number | undefined,
    from: { url?: string }
  ): Promise<Saved> {
    const { version, zip } = manifest
    const tag = releaseTag(version)
    const fail = (reason: string, unreachable = false): Saved => {
      this.deps.events.error(tag, `Firmware ${version} couldn’t be downloaded: ${reason}.`)
      return { ok: false, check: { kind: 'download-failed', version }, unreachable }
    }
    if (!from.url) return fail(`the release has no ${zip.name}`)
    let bytes: Uint8Array
    try {
      bytes = await this.github.bytes(from.url, zip.size)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), true)
    }
    if (sha256(bytes) !== zip.sha256)
      return fail('its SHA-256 doesn’t match the release’s manifest')

    const r = await this.cache.install({ manifest, manifestText: text, publishedAt, zip: bytes })
    if (r.ok) {
      this.emptied = false
      this.deps.events.forget(tag)
      return { ok: true }
    }
    if (r.kind === 'refused') return fail(r.reason)
    if (r.kind === 'disk-full') {
      const message = imageErrorText('disk', version, { full: true, neededBytes: r.neededBytes })
      this.deps.events.error(tag, message.replace(/\.$/, `: ${r.reason}.`))
      return {
        ok: false,
        check: { kind: 'disk-full', version, neededBytes: r.neededBytes },
        unreachable: false
      }
    }
    this.deps.events.error(tag, `Firmware ${version} couldn’t be saved: ${r.reason}.`)
    return { ok: false, check: { kind: 'not-saved', version }, unreachable: false }
  }

  // ── Clear ──────────────────────────────────────────────────────────────────

  /**
   * *Clear*: remove every saved release. Refused (false) while nothing is saved or an update is
   * reading a file. The last check is kept.
   */
  async clear(): Promise<boolean> {
    if (!this.state().canClear) return false
    await this.cache.clear()
    this.emptied = true
    this.push()
    return true
  }

  // ── what the update flows call ─────────────────────────────────────────────

  /**
   * An image's bytes and its manifest entry, its size and SHA-256 re-checked on every call. A
   * missing or damaged file is repaired once (the version downloaded and unpacked again).
   */
  getFile(source: ImageSourceRef, sel: ImageSelector): Promise<GetFileResult> {
    return this.sources[source.kind].get(source, sel)
  }

  /**
   * The manifest entry a selector means in a saved version, from its manifest only: never an
   * image file, a SHA-256 or a download.
   */
  imageFor(version: string, sel: ImageSelector): ImageForResult {
    const m = this.cache.match(version, sel)
    if (m.kind === 'ok') return { ok: true, entry: entryOf(m.entry) }
    if (m.kind === 'ambiguous') this.deps.log('releases.ambiguous', { version, sel })
    return this.error(m.kind, version)
  }

  private error(kind: ImageErrorKind, version: string, neededBytes?: number): ImageError {
    const disk = neededBytes === undefined ? undefined : { full: true, neededBytes }
    return { ok: false, error: kind, message: imageErrorText(kind, version, disk) }
  }

  private async fromRelease(source: ImageSourceRef, sel: ImageSelector): Promise<GetFileResult> {
    const { version } = source
    const letGo = this.cache.hold(version)
    this.push() // Clear waits while an update reads
    try {
      let r = await this.cache.read(version, sel)
      if (r.kind === 'damaged') {
        const repaired = await this.repair(version)
        if (repaired === 'unreachable') return this.error('damaged', version)
        if (!repaired.ok) {
          if (repaired.kind === 'disk-full')
            return this.error('disk', version, repaired.neededBytes)
          if (repaired.kind === 'not-saved') return this.error('disk', version)
          return this.error('damaged', version)
        }
        r = await this.cache.read(version, sel)
      }
      switch (r.kind) {
        case 'ok':
          return { ok: true, bytes: r.bytes, entry: entryOf(r.entry), source }
        case 'ambiguous':
          this.deps.log('releases.ambiguous', { version, sel })
          return this.error('ambiguous', version)
        default:
          return this.error(r.kind, version)
      }
    } finally {
      letGo()
      await this.cache.retain()
      this.push()
    }
  }

  /** Download and unpack a saved version again, once; a second read of it joins the repair. */
  private repair(version: string): Promise<InstallResult | 'unreachable'> {
    let running = this.repairs.get(version)
    if (!running) {
      running = this.reinstall(version).finally(() => this.repairs.delete(version))
      this.repairs.set(version, running)
    }
    return running
  }

  private async reinstall(version: string): Promise<InstallResult | 'unreachable'> {
    const saved = this.cache.manifest(version)
    if (!saved) return { ok: false, kind: 'refused', reason: 'not saved' }
    // The flat manifest as it was saved: the zip record it holds is what the download must match.
    const { manifest, text } = saved
    const result = await this.save(manifest, text, this.cache.publishedAt(version), {
      url: assetUrl(manifest.tag, manifest.zip.name)
    })
    if (result.ok) return { ok: true }
    if (result.unreachable) return 'unreachable'
    if (result.check.kind === 'disk-full') {
      return { ok: false, kind: 'disk-full', neededBytes: result.check.neededBytes, reason: '' }
    }
    if (result.check.kind === 'not-saved') return { ok: false, kind: 'not-saved', reason: '' }
    return { ok: false, kind: 'refused', reason: '' }
  }
}
