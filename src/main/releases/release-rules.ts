// The firmware release package's rules (#192), pure: which GitHub releases count and in what
// order, what a flat manifest.json must hold, which names a release zip may carry, which file an
// update's selector means, and which saved versions retention keeps. No I/O.
//
// The one owner of version order: the tag parse and the version compare live here, and the update
// flows (#173 up to date / update available, #177's version list) use them.
//
// The release-package facts are named once, below, each citing where the firmware repo makes it
// (OpenSkyHawk/OpenSkyhawk at `firmware-v0.3.0`). None is a firmware wire value, so none comes
// from `npm run sync`.
import type { FirmwareVersion } from '@shared/gateway'
import type { ReleaseInfo } from '@shared/releases'
import { megabytes } from '@shared/format'

/** The repo the firmware releases are published in (`release-please.yml:134`, `gh release upload`). */
export const RELEASE_REPO = 'OpenSkyHawk/OpenSkyhawk'

/** A firmware release's tag is this prefix and its version (`firmware-release-assets.yml:90-91`). */
export const FIRMWARE_TAG_PREFIX = 'firmware-v'

/** The flat manifest's `schema` this client reads (`firmware-release-assets.yml:224`, `:263`). */
export const MANIFEST_SCHEMA = 2

/**
 * The oldest release this client reads: the first with the zip and the schema 2 manifest
 * (OpenSkyhawk#402). Older releases (flat files, schema 1) are not supported.
 */
export const MIN_FIRMWARE = '0.3.0'

/** The zip's one top folder, which every entry and manifest `path` is under (`:146`, `:177-180`). */
export const zipTopFolder = (version: string): string => `openskyhawk-firmware-${version}/`

/** The flat manifest's asset name on the release (`firmware-release-assets.yml:260-264`). */
export const MANIFEST_ASSET = 'manifest.json'

/** Saved releases kept on this computer, newest by version (user, 2026-10-27). */
export const KEEP_VERSIONS = 5

/** Where a release asset downloads from, by its tag and name: GitHub's release download URL. */
export const assetUrl = (tag: string, name: string): string =>
  `https://github.com/${RELEASE_REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`

/** The releases list: one API request per check (unauthenticated, 60 an hour per IP). */
export const RELEASES_API = `https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=100`

// ── versions ─────────────────────────────────────────────────────────────────

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** `x.y.z` (no suffix, no leading zeros) as a version; anything else is undefined. */
export function parseVersion(text: string): FirmwareVersion | undefined {
  const m = VERSION_RE.exec(text)
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : undefined
}

/** A firmware release tag (`firmware-v1.0.1`) as its version text; a suffix (`-rc.1`) is none. */
export function tagVersion(tag: string): string | undefined {
  if (!tag.startsWith(FIRMWARE_TAG_PREFIX)) return undefined
  const v = tag.slice(FIRMWARE_TAG_PREFIX.length)
  return parseVersion(v) ? v : undefined
}

/** The version order: negative when `a` is older than `b`. Both must be `x.y.z`. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) throw new Error(`not a version: ${x ? b : a}`)
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch
}

/** Newest first. */
export const newestFirst = (versions: readonly string[]): string[] =>
  [...versions].sort((a, b) => compareVersions(b, a))

// ── the releases list ────────────────────────────────────────────────────────

/** A release asset as the check uses it. */
export interface ListedAsset {
  url: string
  size: number
}

/** A firmware release from GitHub's list that this client may read. */
export interface ListedRelease extends ReleaseInfo {
  tag: string
  /** Its assets by name. */
  assets: Map<string, ListedAsset>
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * GitHub's releases list, read: only firmware releases, published (no drafts), never a prerelease
 * or a tag with a suffix, at or above the minimum. Anything else in the list (PCB releases, older
 * firmware, malformed entries) is left out. The Latest badge is never read.
 */
export function readReleaseList(raw: unknown): ListedRelease[] {
  if (!Array.isArray(raw)) return []
  const out: ListedRelease[] = []
  for (const r of raw) {
    if (!isObject(r) || r.draft !== false || r.prerelease !== false) continue
    if (typeof r.tag_name !== 'string') continue
    const version = tagVersion(r.tag_name)
    if (!version || compareVersions(version, MIN_FIRMWARE) < 0) continue
    const date = typeof r.published_at === 'string' ? Date.parse(r.published_at) : NaN
    if (Number.isNaN(date)) continue
    const assets = new Map<string, ListedAsset>()
    for (const a of Array.isArray(r.assets) ? r.assets : []) {
      if (!isObject(a) || typeof a.name !== 'string') continue
      if (typeof a.browser_download_url !== 'string' || typeof a.size !== 'number') continue
      assets.set(a.name, { url: a.browser_download_url, size: a.size })
    }
    out.push({ tag: r.tag_name, version, date, assets })
  }
  return out
}

/** The check's pick from the list. */
export interface ReleasePick {
  /** The releases on a major this client supports, highest first: the first good one is latest. */
  candidates: ListedRelease[]
  /** The highest release on a newer major than this client supports: reported only. */
  newerMajor?: ListedRelease
}

/**
 * Split the list by the major this client supports (`newerThanClient`, gateway's rule, injected).
 * "The latest release" is the highest on a supported major: with 1.0.2 and 2.0.0 out, 1.0.2 is the
 * candidate and 2.0.0 is only reported.
 */
export function pickReleases(
  list: readonly ListedRelease[],
  newerThanClient: (v: FirmwareVersion) => boolean
): ReleasePick {
  const sorted = [...list].sort((a, b) => compareVersions(b.version, a.version))
  const newer = (r: ListedRelease) => newerThanClient(parseVersion(r.version)!)
  return { candidates: sorted.filter((r) => !newer(r)), newerMajor: sorted.find(newer) }
}

// ── the flat manifest ────────────────────────────────────────────────────────

/** One image in a release, as the manifest lists it. */
export interface ManifestFile {
  name: string
  /** Its entry name in the zip, top folder included. */
  path: string
  board: string
  format: string
  size: number
  sha256: string
  /** The Gateway's RP2040 (USB side). */
  side?: 'usb'
  /** An STM32 board's NODE_ID. The bootloader-only `.elf` has neither this nor `side`. */
  nodeId?: number
}

/** The zip's own record, only in the flat manifest. */
export interface ZipRecord {
  name: string
  size: number
  sha256: string
}

/** A flat `manifest.json`, schema 2, read. */
export interface ReleaseManifest {
  version: string
  tag: string
  zip: ZipRecord
  files: ManifestFile[]
}

const SHA256_RE = /^[0-9a-f]{64}$/
const isSize = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

function readFile(raw: unknown, version: string): ManifestFile | string {
  if (!isObject(raw)) return 'a file entry is not an object'
  const { name, path, board, format, size, sha256, side, nodeId } = raw
  if (typeof name !== 'string' || typeof board !== 'string' || typeof format !== 'string') {
    return 'a file entry has no name, board or format'
  }
  if (typeof path !== 'string') return `${name} has no path`
  const refused = zipNameProblem(path, version)
  if (refused) return `${name}'s path ${refused}`
  if (!isSize(size) || typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
    return `${name} has no valid size or SHA-256`
  }
  if (side !== undefined && side !== 'usb') return `${name} has an unknown side`
  if (nodeId !== undefined && !Number.isSafeInteger(nodeId)) return `${name} has an invalid nodeId`
  return {
    name,
    path,
    board,
    format,
    size,
    sha256,
    ...(side === 'usb' && { side }),
    ...(nodeId !== undefined && { nodeId: nodeId as number })
  }
}

/**
 * A flat manifest read against what it must be for: schema 2, its `version` and `tag` the
 * release's, the zip record whole, and every file entry whole with a `path` the zip-slip rule
 * accepts. Anything else is the reason it is refused.
 */
export function readManifest(
  raw: unknown,
  expect: { version: string; tag: string }
): { ok: true; manifest: ReleaseManifest } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason })
  if (!isObject(raw)) return no('it is not a manifest')
  if (raw.schema !== MANIFEST_SCHEMA) return no(`its schema is ${String(raw.schema)}, not 2`)
  if (raw.version !== expect.version) return no(`its version is ${String(raw.version)}`)
  if (raw.tag !== expect.tag) return no(`its tag is ${String(raw.tag)}`)
  const zip = raw.zip
  if (
    !isObject(zip) ||
    typeof zip.name !== 'string' ||
    !isSize(zip.size) ||
    typeof zip.sha256 !== 'string' ||
    !SHA256_RE.test(zip.sha256)
  ) {
    return no('it has no valid zip record')
  }
  if (!Array.isArray(raw.files)) return no('it lists no files')
  const files: ManifestFile[] = []
  for (const f of raw.files) {
    const file = readFile(f, expect.version)
    if (typeof file === 'string') return no(file)
    files.push(file)
  }
  return {
    ok: true,
    manifest: {
      version: expect.version,
      tag: expect.tag,
      zip: { name: zip.name, size: zip.size, sha256: zip.sha256 },
      files
    }
  }
}

// ── names in the zip ─────────────────────────────────────────────────────────

/**
 * The zip-slip rule, for every entry name (folders included) and every manifest `path`: why the
 * name is refused, or undefined when it may be written. A refused name fails the whole version.
 */
export function zipNameProblem(name: string, version: string): string | undefined {
  if (name.includes('\\')) return 'contains a backslash'
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return 'is absolute'
  if (name.includes('..')) return 'contains ..'
  if (!name.startsWith(zipTopFolder(version))) return `is not under ${zipTopFolder(version)}`
  return undefined
}

/** A zip entry's (or manifest `path`'s) place in the version folder: the name minus its top folder. */
export const inVersionFolder = (name: string, version: string): string =>
  name.slice(zipTopFolder(version).length)

// ── which image an update means ──────────────────────────────────────────────

/** What an update asks for. `board` breaks the node-0 `elf` tie (the app and the bootloader). */
export interface ImageSelector {
  board?: string
  side?: 'usb'
  nodeId?: number
  format: string
}

export type ImageMatch =
  | { kind: 'ok'; entry: ManifestFile }
  | { kind: 'no-image' }
  | { kind: 'ambiguous'; count: number }

/** Exactly one manifest entry must match the selector. */
export function matchImage(files: readonly ManifestFile[], sel: ImageSelector): ImageMatch {
  const hits = files.filter(
    (f) =>
      f.format === sel.format &&
      (sel.side === undefined || f.side === sel.side) &&
      (sel.nodeId === undefined || f.nodeId === sel.nodeId) &&
      (sel.board === undefined || f.board === sel.board)
  )
  if (hits.length === 1) return { kind: 'ok', entry: hits[0] }
  return hits.length === 0 ? { kind: 'no-image' } : { kind: 'ambiguous', count: hits.length }
}

// ── retention ────────────────────────────────────────────────────────────────

/**
 * The saved versions to delete: the oldest beyond the newest 5. A version an update is reading
 * (`held`) waits for the next pass.
 */
export function beyondKept(versions: readonly string[], held: ReadonlySet<string>): string[] {
  return newestFirst(versions)
    .slice(KEEP_VERSIONS)
    .filter((v) => !held.has(v))
}

// ── what an update is told ───────────────────────────────────────────────────

/** Why `getFile` (or `imageFor`) gave no image. */
export type ImageErrorKind = 'no-image' | 'ambiguous' | 'not-cached' | 'damaged' | 'disk'

/** The words an update dialog shows for each, ready to show. `ambiguous` is a caller bug. */
export function imageErrorText(
  kind: ImageErrorKind,
  version: string,
  disk?: { full: boolean; neededBytes: number }
): string {
  switch (kind) {
    case 'no-image':
      return `Firmware ${version} has no image for this board.`
    case 'ambiguous':
      return `Firmware ${version} has more than one image for this board.`
    case 'not-cached':
      return `Firmware ${version} isn’t on this computer.`
    case 'damaged':
      return `The saved copy of firmware ${version} is damaged and couldn’t be downloaded again.`
    case 'disk':
      return disk?.full
        ? `Not enough space to save firmware ${version} (${megabytes(disk.neededBytes)} needed).`
        : `Firmware ${version} couldn’t be saved.`
  }
}
