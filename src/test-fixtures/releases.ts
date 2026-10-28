// A fake GitHub for the firmware release check (#192; test-only: no production code may import
// this folder). It builds a firmware release the way the firmware repo's
// firmware-release-assets.yml does — the zip with its one top folder, the board folders, the
// READMEs, CHANGES.md, LICENSE and the inner manifest, and the flat schema 2 manifest with the
// zip record — in the 0.3.0 layout, with small stand-in images (the Gateway's .uf2 at its real
// 0.3.0 size). It serves the releases list and the assets on the fetch port and records every
// request.
import { createHash } from 'node:crypto'
import { strToU8, zipSync, type Zippable } from 'fflate'
import type { FetchPort } from '../main/releases'

const REPO = 'OpenSkyHawk/OpenSkyhawk'
export const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`
const download = (tag: string, name: string) =>
  `https://github.com/${REPO}/releases/download/${tag}/${name}`

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** The Gateway's .uf2 in the real 0.3.0 release. */
export const UF2_SIZE_030 = 294_912

/** A stand-in image: `size` bytes that name the file, so each image differs. */
function image(path: string, size: number): Uint8Array {
  const seed = strToU8(`${path}\n`)
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i++) out[i] = seed[i % seed.length]
  return out
}

interface Board {
  folder: string
  base: string
  node: 'usb' | number
}

/** The boards a release ships (`firmware-release-assets.yml:106-115`). */
const BOARDS: Board[] = [
  { folder: 'gateway', base: 'gateway', node: 'usb' },
  { folder: 'gateway', base: 'gateway-bridge', node: 0 },
  { folder: 'pdu-left', base: 'pdu-left', node: 3 },
  { folder: 'pdu-right', base: 'pdu-right', node: 4 },
  { folder: 'pdu-center', base: 'pdu-center', node: 5 }
]

export interface ManifestEntry {
  name: string
  path: string
  board: string
  format: string
  size: number
  sha256: string
  side?: 'usb'
  nodeId?: number
}

export interface BuiltRelease {
  version: string
  tag: string
  /** Every zip entry by name (folders end in `/`), as zipped. */
  entries: Record<string, Uint8Array>
  zip: Uint8Array
  /** The flat manifest, as the release carries it. */
  manifest: Record<string, unknown> & { files: ManifestEntry[] }
  manifestText: string
}

export interface BuildOptions {
  /** Change the zip's entries before it is zipped (a zip-slip name, a swapped image…). */
  entries?: (entries: Record<string, Uint8Array>) => void
  /** Change the flat manifest after it is built from the entries (schema 3, a bad path…). */
  manifest?: (manifest: BuiltRelease['manifest']) => void
}

/** A firmware release, built as the release workflow builds it. */
export function buildRelease(version: string, opts: BuildOptions = {}): BuiltRelease {
  const tag = `firmware-v${version}`
  const top = `openskyhawk-firmware-${version}/`
  const entries: Record<string, Uint8Array> = { [top]: new Uint8Array() }
  const files: ManifestEntry[] = []
  const add = (
    folder: string,
    name: string,
    board: string,
    format: string,
    node: Board['node'] | '-',
    size: number
  ) => {
    const path = `${top}${folder}/${name}`
    const bytes = image(path, size)
    entries[path] = bytes
    files.push({
      name,
      path,
      board,
      format,
      size,
      sha256: sha(bytes),
      ...(node === 'usb' ? { side: 'usb' as const } : node === '-' ? {} : { nodeId: node })
    })
  }
  for (const b of BOARDS) {
    entries[`${top}${b.folder}/`] = new Uint8Array()
    if (b.node === 'usb') {
      add(b.folder, `${b.base}-${version}.uf2`, b.folder, 'uf2', 'usb', UF2_SIZE_030)
      continue
    }
    add(b.folder, `${b.base}-${version}.bin`, b.folder, 'bin', b.node, 3000)
    add(b.folder, `${b.base}-${version}.elf`, b.folder, 'elf', b.node, 7000)
    add(b.folder, `${b.base}-${version}-full.hex`, b.folder, 'hex', b.node, 10000)
    entries[`${top}${b.folder}/README.md`] = strToU8(`# ${b.folder}\n`)
  }
  entries[`${top}bootloader/`] = new Uint8Array()
  add('bootloader', `bootloader-${version}.elf`, 'bootloader', 'elf', '-', 1400)
  add('bootloader', `bootloader-bridge-${version}.elf`, 'bootloader', 'elf', 0, 1400)
  entries[`${top}README.md`] = strToU8(`# OpenSkyhawk firmware ${version}\n`)
  entries[`${top}CHANGES.md`] = strToU8(`## ${version}\n`)
  entries[`${top}LICENSE`] = strToU8('GPL-2.0\n')

  const inner = {
    schema: 2,
    version,
    tag,
    bootloader: { protocol: 1, tag },
    files
  }
  entries[`${top}manifest.json`] = strToU8(JSON.stringify(inner, null, 2))
  opts.entries?.(entries)
  const zip = zipSync(entries as Zippable)
  const manifest: BuiltRelease['manifest'] = {
    schema: 2,
    version,
    tag,
    zip: { name: `openskyhawk-firmware-${version}.zip`, size: zip.length, sha256: sha(zip) },
    bootloader: inner.bootloader,
    files
  }
  opts.manifest?.(manifest)
  return { version, tag, entries, zip, manifest, manifestText: JSON.stringify(manifest, null, 2) }
}

/** One release as GitHub lists it, and the assets it serves. */
export interface FakeRelease {
  tag: string
  draft?: boolean
  prerelease?: boolean
  publishedAt: string
  /** Asset name → bytes. */
  assets: Map<string, Uint8Array>
}

/** Every unpacked file's total size, as the zip's directory gives it. */
export const unpackedSize = (r: BuiltRelease): number =>
  Object.values(r.entries).reduce((n, b) => n + b.length, 0)

export class FakeGitHub {
  readonly releases: FakeRelease[] = []
  /** Every URL requested, in order. */
  readonly requests: string[] = []
  /** Every request's headers, in order. */
  readonly headers: Record<string, string>[] = []
  /** Nothing answers: every request rejects, as a fetch does offline. */
  offline = false
  /** The API limit is reached: the releases list answers 403 with these headers. */
  rateLimitedUntil?: number
  /** Asset URLs whose download stops halfway, the connection dropped. */
  readonly cutOff = new Set<string>()
  /** Requests wait for this before they answer (a check still running). */
  gate?: Promise<void>

  /** Publish a built release (its zip, flat manifest and dependencies.txt). */
  publish(
    r: BuiltRelease,
    opts: {
      date?: string
      manifest?: boolean
      draft?: boolean
      prerelease?: boolean
      tag?: string
    } = {}
  ): FakeRelease {
    const assets = new Map<string, Uint8Array>()
    assets.set(`openskyhawk-firmware-${r.version}.zip`, r.zip)
    if (opts.manifest !== false) assets.set('manifest.json', strToU8(r.manifestText))
    assets.set('dependencies.txt', strToU8('deps\n'))
    return this.add({
      tag: opts.tag ?? r.tag,
      draft: opts.draft,
      prerelease: opts.prerelease,
      publishedAt: opts.date ?? '2026-10-27T18:06:20Z',
      assets
    })
  }

  add(release: FakeRelease): FakeRelease {
    this.releases.push(release)
    return release
  }

  /** The asset URLs requested (everything but the releases list). */
  assetRequests(): string[] {
    return this.requests.filter((u) => u !== RELEASES_URL)
  }

  apiRequests(): number {
    return this.requests.filter((u) => u === RELEASES_URL).length
  }

  readonly fetch: FetchPort = async (url, init) => {
    this.requests.push(url)
    this.headers.push(init.headers)
    if (this.gate) await this.gate
    if (this.offline) throw new TypeError('fetch failed')
    if (url === RELEASES_URL) {
      if (this.rateLimitedUntil !== undefined) {
        return new Response('{"message":"API rate limit exceeded"}', {
          status: 403,
          headers: {
            'x-ratelimit-limit': '60',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(this.rateLimitedUntil / 1000))
          }
        })
      }
      const list = this.releases.map((r) => ({
        tag_name: r.tag,
        draft: r.draft ?? false,
        prerelease: r.prerelease ?? false,
        published_at: r.publishedAt,
        assets: [...r.assets].map(([name, bytes]) => ({
          name,
          size: bytes.length,
          browser_download_url: download(r.tag, name)
        }))
      }))
      return Response.json(list, { headers: { 'x-ratelimit-remaining': '59' } })
    }
    for (const r of this.releases) {
      for (const [name, bytes] of r.assets) {
        if (download(r.tag, name) !== url) continue
        if (this.cutOff.has(url)) return cutOffResponse(bytes)
        return new Response(bytes.slice())
      }
    }
    return new Response('Not Found', { status: 404 })
  }
}

/** A body that stops halfway, the connection dropped. */
function cutOffResponse(bytes: Uint8Array): Response {
  const half = bytes.slice(0, Math.floor(bytes.length / 2))
  const stream = new ReadableStream<Uint8Array>({
    start(ctl) {
      ctl.enqueue(half)
      ctl.error(new TypeError('terminated'))
    }
  })
  return new Response(stream)
}
