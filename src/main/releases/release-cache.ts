// The releases saved on this computer (#192): <userData>/firmware/<version>/, each the release
// zip unpacked minus its top folder, with the flat manifest.json and release.json at its root.
//
//   firmware/0.3.0/manifest.json      the release's flat manifest (with the zip record)
//   firmware/0.3.0/release.json       { tag, publishedAt }: the release date GitHub gave
//   firmware/0.3.0/gateway/…          the zip's layout: board folders, READMEs, CHANGES.md, LICENSE
//   firmware/.tmp-0.4.0.zip           staging while a version is put in place; any `.tmp-*` left
//   firmware/.tmp-0.4.0/              over is deleted by the start scan
//
// A version is put in place whole or not at all: every name is checked before anything is
// written, the zip is unpacked into a temp folder, and that folder is renamed into place only once
// every manifest file is there with its size and SHA-256. Any failure removes the temp zip and
// folder, and the cache stays as it was. Disk changes run one at a time.
import { createHash } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { unzipSync } from 'fflate'
import type { CachedVersion } from '@shared/releases'
import { fileErrorText } from '@shared/format'
import {
  beyondKept,
  FIRMWARE_TAG_PREFIX,
  inVersionFolder,
  matchImage,
  newestFirst,
  parseVersion,
  readManifest,
  zipNameProblem,
  zipTopFolder,
  type ImageMatch,
  type ImageSelector,
  type ManifestFile,
  type ReleaseManifest
} from './release-rules'

/** The file operations the cache makes: node's, or a test's that fails on purpose. */
export interface CacheFs {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array | string): Promise<void>
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>
  rm(path: string, opts: { recursive: true; force: true }): Promise<void>
  rename(from: string, to: string): Promise<void>
  readdir(path: string): Promise<string[]>
  stat(path: string): Promise<{ isDirectory(): boolean; size: number }>
}

const nodeFs: CacheFs = {
  readFile: (p) => fsp.readFile(p),
  writeFile: (p, d) => fsp.writeFile(p, d),
  mkdir: (p, o) => fsp.mkdir(p, o),
  rm: (p, o) => fsp.rm(p, o),
  rename: (a, b) => fsp.rename(a, b),
  readdir: (p) => fsp.readdir(p),
  stat: (p) => fsp.stat(p)
}

/**
 * Port: the event log, as the cache reports to it (app wires the EventJournal). Same dedupe per
 * tag as the calibration cache's rows.
 */
export interface ReleaseEvents {
  error(tag: string, message: string): void
  warn(tag: string, message: string): void
  forget(tag: string): void
}

/** The event-log name of a release's rows: the version as the UI writes it. */
export const releaseTag = (version: string): string => `Firmware ${version}`

/** Staging names start with this; the start scan deletes whatever has it. */
const TMP = '.tmp-'
const MANIFEST = 'manifest.json'
const RELEASE_JSON = 'release.json'

/** What install was given: the release, its flat manifest as read and as downloaded, the zip. */
export interface InstallInput {
  manifest: ReleaseManifest
  /** The flat manifest's bytes, written at the version's root as they came. */
  manifestText: string
  publishedAt?: number
  zip: Uint8Array
}

export type InstallResult =
  | { ok: true }
  /** A refused name, or a file that doesn't match its manifest entry. Nothing was kept. */
  | { ok: false; kind: 'refused'; reason: string }
  /** The disk is full: `neededBytes` is the zip plus what it unpacks to. Nothing was kept. */
  | { ok: false; kind: 'disk-full'; neededBytes: number; reason: string }
  /** Another write error. Nothing was kept. */
  | { ok: false; kind: 'not-saved'; reason: string }

/** A file read for an update. */
export type ReadResult =
  | { kind: 'ok'; entry: ManifestFile; bytes: Uint8Array }
  | { kind: 'not-cached' }
  | Exclude<ImageMatch, { kind: 'ok' }>
  /** The file is missing or doesn't match its entry: `getFile` repairs it. */
  | { kind: 'damaged'; entry: ManifestFile }

interface Saved {
  manifest: ReleaseManifest
  /** The flat manifest.json as it was saved: a repair checks its download against it. */
  manifestText: string
  publishedAt?: number
  bytes: number
}

export const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

const isEnospc = (err: unknown) => (err as { code?: unknown } | null)?.code === 'ENOSPC'

export class ReleaseCache {
  private readonly saved = new Map<string, Saved>()
  /** Reads in progress per version: a version being read is never deleted. */
  private readonly reading = new Map<string, number>()
  /** Disk changes, one at a time. */
  private queue: Promise<unknown> = Promise.resolve()
  private readonly fs: CacheFs

  constructor(
    private readonly deps: {
      /** <userData>/firmware. */
      dir: () => string
      events: ReleaseEvents
      fs?: CacheFs
    }
  ) {
    this.fs = deps.fs ?? nodeFs
  }

  /** Run a disk change after the ones before it. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  // ── what is saved ──────────────────────────────────────────────────────────

  /** The saved versions, newest first, with their release date and size on disk. */
  list(): CachedVersion[] {
    return newestFirst([...this.saved.keys()]).map((version) => {
      const s = this.saved.get(version)!
      return {
        version,
        ...(s.publishedAt !== undefined && { date: s.publishedAt }),
        bytes: s.bytes
      }
    })
  }

  /** The newest saved version. */
  newest(): string | undefined {
    return newestFirst([...this.saved.keys()])[0]
  }

  manifest(version: string): { manifest: ReleaseManifest; text: string } | undefined {
    const s = this.saved.get(version)
    return s && { manifest: s.manifest, text: s.manifestText }
  }

  publishedAt(version: string): number | undefined {
    return this.saved.get(version)?.publishedAt
  }

  /** An update is reading a file. */
  busy(): boolean {
    return this.reading.size > 0
  }

  /**
   * Hold a version while an update reads it; the returned function lets go. Retention runs again
   * when the last read of a version ends, so a version it held back goes then.
   */
  hold(version: string): () => void {
    this.reading.set(version, (this.reading.get(version) ?? 0) + 1)
    let done = false
    return () => {
      if (done) return
      done = true
      const n = (this.reading.get(version) ?? 1) - 1
      if (n > 0) this.reading.set(version, n)
      else this.reading.delete(version)
    }
  }

  // ── start ──────────────────────────────────────────────────────────────────

  /**
   * On start: drop any version folder with no manifest, one that doesn't parse, or a `version`
   * that isn't its folder's name (a warn row each), and delete any leftover staging. A damaged
   * file inside a good version is caught when it is read. Answers whether it dropped every
   * folder there was.
   */
  scan(): Promise<{ droppedAll: boolean }> {
    return this.serial(async () => {
      const dir = this.deps.dir()
      let names: string[]
      try {
        names = await this.fs.readdir(dir)
      } catch {
        return { droppedAll: false } // no folder yet: nothing saved
      }
      let folders = 0
      let dropped = 0
      for (const name of names) {
        const path = join(dir, name)
        if (name.startsWith(TMP)) {
          await this.fs.rm(path, { recursive: true, force: true }).catch(() => {})
          continue
        }
        let isDir = false
        try {
          isDir = (await this.fs.stat(path)).isDirectory()
        } catch {
          continue
        }
        if (!isDir) continue
        folders++
        const reason = await this.load(name, path)
        if (reason === undefined) continue
        dropped++
        await this.fs.rm(path, { recursive: true, force: true }).catch(() => {})
        this.deps.events.warn(
          releaseTag(name),
          `Dropped the saved firmware folder ${name}: ${reason}.`
        )
      }
      await this.prune()
      return { droppedAll: folders > 0 && dropped === folders }
    })
  }

  /** Load one version folder; undefined when it is good, else why it is dropped. */
  private async load(name: string, path: string): Promise<string | undefined> {
    if (!parseVersion(name)) return 'its name is not a version'
    let raw: unknown
    let manifestText: string
    try {
      manifestText = Buffer.from(await this.fs.readFile(join(path, MANIFEST))).toString('utf8')
      raw = JSON.parse(manifestText)
    } catch (err) {
      return (err as { code?: unknown }).code === 'ENOENT'
        ? 'it has no manifest'
        : 'its manifest does not parse'
    }
    const read = readManifest(raw, { version: name, tag: `${FIRMWARE_TAG_PREFIX}${name}` })
    if (!read.ok) return `its manifest is not for this folder (${read.reason})`
    let publishedAt: number | undefined
    try {
      const rel = JSON.parse(
        Buffer.from(await this.fs.readFile(join(path, RELEASE_JSON))).toString('utf8')
      ) as { publishedAt?: unknown }
      if (typeof rel.publishedAt === 'number') publishedAt = rel.publishedAt
    } catch {
      // no release date: the version still installs
    }
    this.saved.set(name, {
      manifest: read.manifest,
      manifestText,
      publishedAt,
      bytes: await this.size(path)
    })
    return undefined
  }

  /** A folder's size on disk: every file in it, at any depth. */
  private async size(path: string): Promise<number> {
    let total = 0
    for (const name of await this.fs.readdir(path).catch(() => [] as string[])) {
      const p = join(path, name)
      const st = await this.fs.stat(p).catch(() => undefined)
      if (!st) continue
      total += st.isDirectory() ? await this.size(p) : st.size
    }
    return total
  }

  // ── putting a version in place ─────────────────────────────────────────────

  /**
   * Unpack a downloaded zip whose own size and SHA-256 already matched its manifest record, and put
   * the version in place (over the saved one, for a repair). Then retention runs.
   */
  install(input: InstallInput): Promise<InstallResult> {
    return this.serial(() => this.put(input))
  }

  private async put({
    manifest,
    manifestText,
    publishedAt,
    zip
  }: InstallInput): Promise<InstallResult> {
    const { version } = manifest
    const dir = this.deps.dir()
    const tmpZip = join(dir, `${TMP}${version}.zip`)
    const tmpDir = join(dir, `${TMP}${version}`)
    const oldDir = join(dir, `${TMP}old-${version}`)
    const target = join(dir, version)

    // The zip's directory first, inflating nothing: every name is checked before anything is
    // written, and the size it unpacks to is what a full disk is told it needs.
    const names: string[] = []
    let unpacked = 0
    try {
      unzipSync(zip, {
        filter: (f) => {
          names.push(f.name)
          unpacked += f.originalSize
          return false
        }
      })
    } catch {
      return { ok: false, kind: 'refused', reason: 'the download is not a zip' }
    }
    for (const name of names) {
      const refused = zipNameProblem(name, version)
      if (refused) return { ok: false, kind: 'refused', reason: `the zip entry ${name} ${refused}` }
    }
    const neededBytes = zip.length + unpacked
    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(zip)
    } catch {
      return { ok: false, kind: 'refused', reason: 'the zip does not unpack' }
    }

    const replacing = this.saved.has(version)
    let movedAside = false
    try {
      await this.fs.mkdir(dir, { recursive: true })
      await this.fs.rm(tmpDir, { recursive: true, force: true })
      await this.fs.writeFile(tmpZip, zip)

      for (const f of manifest.files) {
        const bytes = entries[f.path]
        if (!bytes) return await this.undo(tmpZip, tmpDir, `${f.path} is not in the zip`)
        if (bytes.length !== f.size || sha256(bytes) !== f.sha256) {
          return await this.undo(tmpZip, tmpDir, `${f.name} does not match the manifest`)
        }
      }

      // Every entry is written by the client as a plain file (or a folder), never as a link. The
      // zip's own manifest.json is the flat one minus its zip record: the flat one is written.
      const innerManifest = `${zipTopFolder(version)}${MANIFEST}`
      await this.fs.mkdir(tmpDir, { recursive: true })
      let bytesOnDisk = 0
      for (const [name, bytes] of Object.entries(entries)) {
        if (name === innerManifest) continue
        const rel = inVersionFolder(name, version)
        if (rel === '') continue
        const path = join(tmpDir, rel)
        if (name.endsWith('/')) {
          await this.fs.mkdir(path, { recursive: true })
          continue
        }
        await this.fs.mkdir(dirname(path), { recursive: true })
        await this.fs.writeFile(path, bytes)
        bytesOnDisk += bytes.length
      }
      const releaseJson = JSON.stringify(
        { tag: manifest.tag, ...(publishedAt !== undefined && { publishedAt }) },
        null,
        2
      )
      await this.fs.writeFile(join(tmpDir, MANIFEST), manifestText)
      await this.fs.writeFile(join(tmpDir, RELEASE_JSON), releaseJson)
      bytesOnDisk += Buffer.byteLength(manifestText) + Buffer.byteLength(releaseJson)

      // Into place: a saved copy (a repair) moves aside first and goes once the new one stands.
      if (replacing) {
        await this.fs.rm(oldDir, { recursive: true, force: true })
        await this.fs.rename(target, oldDir).then(
          () => (movedAside = true),
          () => this.fs.rm(target, { recursive: true, force: true })
        )
      }
      await this.fs.rename(tmpDir, target)
      this.saved.set(version, { manifest, manifestText, publishedAt, bytes: bytesOnDisk })
      await this.fs.rm(tmpZip, { recursive: true, force: true }).catch(() => {})
      if (replacing) await this.fs.rm(oldDir, { recursive: true, force: true }).catch(() => {})
    } catch (err) {
      await this.discard(tmpZip, tmpDir)
      if (movedAside) await this.fs.rename(oldDir, target).catch(() => {}) // the saved copy back
      return isEnospc(err)
        ? { ok: false, kind: 'disk-full', neededBytes, reason: fileErrorText(err) }
        : { ok: false, kind: 'not-saved', reason: fileErrorText(err) }
    }
    await this.prune()
    return { ok: true }
  }

  private async undo(tmpZip: string, tmpDir: string, reason: string): Promise<InstallResult> {
    await this.discard(tmpZip, tmpDir)
    return { ok: false, kind: 'refused', reason }
  }

  private async discard(tmpZip: string, tmpDir: string): Promise<void> {
    await this.fs.rm(tmpZip, { recursive: true, force: true }).catch(() => {})
    await this.fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }

  // ── retention and Clear ────────────────────────────────────────────────────

  /**
   * Keep the newest 5. A version being read waits; a folder that can't be deleted (locked on
   * Windows) stays, and the next pass tries again.
   */
  private async prune(): Promise<void> {
    for (const version of beyondKept([...this.saved.keys()], new Set(this.reading.keys()))) {
      try {
        await this.fs.rm(join(this.deps.dir(), version), { recursive: true, force: true })
        this.saved.delete(version)
      } catch {
        // stays until the next pass
      }
    }
  }

  /** A retention pass on its own: after an update's read ends. */
  retain(): Promise<void> {
    return this.serial(() => this.prune())
  }

  /** *Clear*: remove every saved version. A folder that can't be deleted stays. */
  clear(): Promise<void> {
    return this.serial(async () => {
      for (const version of [...this.saved.keys()]) {
        try {
          await this.fs.rm(join(this.deps.dir(), version), { recursive: true, force: true })
          this.saved.delete(version)
        } catch {
          // stays; listed until a later Clear or retention pass removes it
        }
      }
    })
  }

  // ── reading for an update ──────────────────────────────────────────────────

  /** The manifest entry a selector means in a saved version; reads no file. */
  match(version: string, sel: ImageSelector): ImageMatch | { kind: 'not-cached' } {
    const saved = this.saved.get(version)
    return saved ? matchImage(saved.manifest.files, sel) : { kind: 'not-cached' }
  }

  /** Read one image and re-check its size and SHA-256 against its manifest entry. */
  async read(version: string, sel: ImageSelector): Promise<ReadResult> {
    const m = this.match(version, sel)
    if (m.kind !== 'ok') return m
    const path = join(this.deps.dir(), version, inVersionFolder(m.entry.path, version))
    let bytes: Uint8Array
    try {
      bytes = await this.fs.readFile(path)
    } catch {
      return { kind: 'damaged', entry: m.entry }
    }
    if (bytes.length !== m.entry.size || sha256(bytes) !== m.entry.sha256) {
      return { kind: 'damaged', entry: m.entry }
    }
    return { kind: 'ok', entry: m.entry, bytes }
  }
}
