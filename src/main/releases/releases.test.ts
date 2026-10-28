// The release check and the saved releases (#192), driven as main drives them: a fake GitHub on
// the fetch port, a temporary <userData>, and, where a test needs the disk to fail, a file system
// that fails on purpose. Each test is named as the ticket names it.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReleasesState } from '@shared/releases'
import { jsonFile } from '../config'
import {
  buildRelease,
  FakeGitHub,
  RELEASES_URL,
  UF2_SIZE_030,
  unpackedSize,
  type BuiltRelease
} from '../../test-fixtures/releases'
import type { CacheFs } from './release-cache'
import { Releases } from './releases'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Row {
  severity: 'error' | 'warn'
  tag: string
  message: string
}

/** A launch of the releases service over `dir` (a fresh <userData> unless given). */
function launch(opts: { github?: FakeGitHub; dir?: string; fs?: CacheFs } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'skyhawk-releases-'))
  if (!opts.dir) dirs.push(dir)
  const github = opts.github ?? new FakeGitHub()
  const pushes: ReleasesState[] = []
  const rows: Row[] = []
  const releases = new Releases((_channel, payload) => void pushes.push(payload), {
    fetch: github.fetch,
    userAgent: () => 'OpenSkyhawk-Client/test',
    dir: () => join(dir, 'firmware'),
    checkFile: jsonFile(() => join(dir, 'release-check.json')),
    events: {
      error: (tag, message) => void rows.push({ severity: 'error', tag, message }),
      warn: (tag, message) => void rows.push({ severity: 'warn', tag, message }),
      forget: () => {}
    },
    newerThanClient: (v) => v.major > 1,
    log: () => {},
    fs: opts.fs
  })
  const fw = (...parts: string[]) => join(dir, 'firmware', ...parts)
  return {
    releases,
    github,
    dir,
    pushes,
    rows,
    fw,
    /** The saved versions, newest first. */
    cached: () => releases.cachedVersions().map((c) => c.version),
    /** What is in <userData>/firmware. */
    onDisk: () => (existsSync(fw()) ? readdirSync(fw()).sort() : []),
    check: () => releases.state().check,
    relaunch: (fs?: CacheFs) => launch({ github, dir, fs })
  }
}

/** A launch with each version published and checked in turn, so all of them are saved. */
async function withSaved(versions: string[]) {
  const app = launch()
  await app.releases.open(false)
  for (const v of versions) {
    app.github.publish(buildRelease(v))
    await app.releases.checkNow()
  }
  app.github.requests.length = 0
  return app
}

/** node's file system, with some calls failing. */
function failing(fail: Partial<Record<keyof CacheFs, (path: string) => unknown>>): CacheFs {
  const real: CacheFs = {
    readFile: (p) => fsp.readFile(p),
    writeFile: (p, d) => fsp.writeFile(p, d),
    mkdir: (p, o) => fsp.mkdir(p, o),
    rm: (p, o) => fsp.rm(p, o),
    rename: (a, b) => fsp.rename(a, b),
    readdir: (p) => fsp.readdir(p),
    stat: (p) => fsp.stat(p)
  }
  const wrap = <K extends keyof CacheFs>(k: K) =>
    (async (path: string, ...rest: unknown[]) => {
      const err = fail[k]?.(path)
      if (err instanceof Error) throw err
      if (err instanceof Promise) await err
      return (real[k] as (...a: unknown[]) => unknown)(path, ...rest)
    }) as CacheFs[K]
  return {
    readFile: wrap('readFile'),
    writeFile: wrap('writeFile'),
    mkdir: wrap('mkdir'),
    rm: wrap('rm'),
    rename: wrap('rename'),
    readdir: wrap('readdir'),
    stat: wrap('stat')
  }
}

const fsError = (code: string, path: string) =>
  Object.assign(new Error(`${code}: ${path}`), { code, path })

const USB_UF2 = { side: 'usb', format: 'uf2' } as const

describe('the check', () => {
  it('check.newer-release-downloads: downloaded, verified, unpacked with the flat manifest, zip deleted, served', async () => {
    const app = launch()
    const r = buildRelease('0.3.0')
    app.github.publish(r)
    await app.releases.open(true)

    expect(app.check()).toEqual({ kind: 'ok' })
    expect(app.cached()).toEqual(['0.3.0'])
    expect(app.onDisk()).toEqual(['0.3.0'])
    // The flat manifest (with its zip record) at the root, exactly as the release carries it.
    expect(readFileSync(app.fw('0.3.0', 'manifest.json'), 'utf8')).toBe(r.manifestText)
    expect(JSON.parse(readFileSync(app.fw('0.3.0', 'release.json'), 'utf8'))).toEqual({
      tag: 'firmware-v0.3.0',
      publishedAt: Date.parse('2026-10-27T18:06:20Z')
    })
    expect(readdirSync(app.fw('0.3.0')).sort()).toEqual([
      'CHANGES.md',
      'LICENSE',
      'README.md',
      'bootloader',
      'gateway',
      'manifest.json',
      'pdu-center',
      'pdu-left',
      'pdu-right',
      'release.json'
    ])
    const got = await app.releases.getFile({ kind: 'release', version: '0.3.0' }, USB_UF2)
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.entry.name).toBe('gateway-0.3.0.uf2')
    expect(got.bytes.length).toBe(UF2_SIZE_030)
    expect(got.source).toEqual({ kind: 'release', version: '0.3.0' })
    expect(app.releases.latest()).toEqual({
      version: '0.3.0',
      date: Date.parse('2026-10-27T18:06:20Z')
    })
    // GitHub asked as it requires: a User-Agent, and the API's media type.
    expect(app.github.headers[0]).toEqual({
      'User-Agent': 'OpenSkyhawk-Client/test',
      Accept: 'application/vnd.github+json'
    })
  })

  it('check.same-version-no-download: latest = newest saved → no asset request', async () => {
    const app = await withSaved(['0.3.0'])
    await app.releases.checkNow()
    expect(app.github.requests).toEqual([RELEASES_URL])
    expect(app.check()).toEqual({ kind: 'ok' })
  })

  it('check.only-latest: 0.3.0 saved, 0.4.0 and 0.5.0 out → only 0.5.0 downloaded', async () => {
    const app = await withSaved(['0.3.0'])
    app.github.publish(buildRelease('0.4.0'))
    app.github.publish(buildRelease('0.5.0'))
    await app.releases.checkNow()
    expect(app.cached()).toEqual(['0.5.0', '0.3.0'])
    expect(app.github.assetRequests().every((u) => u.includes('firmware-v0.5.0'))).toBe(true)
  })

  it('check.highest-firmware-tag: a higher hardware tag and the Latest badge elsewhere → the highest firmware-v* wins', async () => {
    const app = launch()
    app.github.publish(buildRelease('0.4.0'))
    app.github.add({ tag: 'pcb-v9.0.0', publishedAt: '2026-10-28T10:00:00Z', assets: new Map() })
    app.github.publish(buildRelease('0.3.0')) // listed last, as the Latest badge's would be
    await app.releases.open(true)
    expect(app.cached()).toEqual(['0.4.0'])
  })

  it('check.no-prereleases: a higher prerelease, a draft and a -rc.1 tag → none listed or downloaded', async () => {
    const app = launch()
    app.github.publish(buildRelease('0.3.0'))
    app.github.publish(buildRelease('0.6.0'), { prerelease: true })
    app.github.publish(buildRelease('0.5.0'), { draft: true })
    app.github.publish(buildRelease('0.4.0'), { tag: 'firmware-v0.4.0-rc.1' })
    await app.releases.open(true)
    expect(app.cached()).toEqual(['0.3.0'])
    expect(app.releases.latest()?.version).toBe('0.3.0')
    expect(app.github.assetRequests().every((u) => u.includes('firmware-v0.3.0/'))).toBe(true)
  })

  it('check.no-manifest-yet: the highest has no manifest.json → skipped, the next used, no row', async () => {
    const app = launch()
    app.github.publish(buildRelease('0.3.0'))
    app.github.publish(buildRelease('0.4.0'), { manifest: false })
    await app.releases.open(true)
    expect(app.cached()).toEqual(['0.3.0'])
    expect(app.releases.latest()?.version).toBe('0.3.0')
    expect(app.rows).toEqual([])
  })

  it('check.bad-manifest: schema 3, or a version ≠ its tag → skipped with a warn row', async () => {
    const app = launch()
    app.github.publish(buildRelease('0.3.0'))
    app.github.publish(buildRelease('0.4.0', { manifest: (m) => void (m.schema = 3) }))
    app.github.publish(buildRelease('0.5.0', { manifest: (m) => void (m.version = '0.5.1') }))
    await app.releases.open(true)
    expect(app.cached()).toEqual(['0.3.0'])
    expect(app.rows).toEqual([
      {
        severity: 'warn',
        tag: 'Firmware 0.5.0',
        message:
          'Firmware 0.5.0 was skipped: its manifest.json can’t be used (its version is 0.5.1).'
      },
      {
        severity: 'warn',
        tag: 'Firmware 0.4.0',
        message:
          'Firmware 0.4.0 was skipped: its manifest.json can’t be used (its schema is 3, not 2).'
      }
    ])
  })

  it('check.no-release: only releases before 0.3.0 → no release found', async () => {
    const app = launch()
    app.github.publish(buildRelease('0.2.0'))
    await app.releases.open(true)
    expect(app.check()).toEqual({ kind: 'no-release' })
    expect(app.releases.latest()).toBeUndefined()
    expect(app.releases.state().last?.checkedAt).toEqual(expect.any(Number))
    expect(app.github.assetRequests()).toEqual([])
  })

  it('check.joins-running: the launch check and Check now → one API request', async () => {
    const app = launch()
    app.github.publish(buildRelease('0.3.0'))
    let go!: () => void
    app.github.gate = new Promise((r) => (go = r))
    const launched = app.releases.open(true)
    await Promise.resolve()
    const first = app.releases.checkNow()
    const second = app.releases.checkNow()
    expect(app.check()).toEqual({ kind: 'checking' })
    go()
    await Promise.all([launched, first, second])
    expect(app.github.apiRequests()).toBe(1)
    expect(app.cached()).toEqual(['0.3.0'])
  })

  it('check.setting-off: no request on launch; Check now still checks', async () => {
    const app = launch()
    app.github.publish(buildRelease('0.3.0'))
    await app.releases.open(false)
    expect(app.github.requests).toEqual([])
    expect(app.check()).toEqual({ kind: 'never' })
    await app.releases.checkNow()
    expect(app.github.apiRequests()).toBe(1)
    expect(app.cached()).toEqual(['0.3.0'])
  })

  it('check.offline: fetch rejects → offline, the last good check kept, getFile still serves', async () => {
    const app = await withSaved(['0.3.0'])
    const last = app.releases.state().last
    app.github.offline = true
    await app.releases.checkNow()
    expect(app.check()).toEqual({ kind: 'offline' })
    expect(app.releases.state().last).toEqual(last)
    expect((await app.releases.getFile({ kind: 'release', version: '0.3.0' }, USB_UF2)).ok).toBe(
      true
    )

    // Relaunched offline: the last check comes back from release-check.json.
    const again = app.relaunch()
    await again.releases.open(true)
    expect(again.check()).toEqual({ kind: 'offline' })
    expect(again.releases.state().last).toEqual(last)
    const got = await again.releases.getFile({ kind: 'release', version: '0.3.0' }, USB_UF2)
    expect(got.ok && got.entry.size).toBe(UF2_SIZE_030)
  })

  it('check.rate-limited: 403 with x-ratelimit-remaining 0 → rate-limited, with the reset time', async () => {
    const app = launch()
    app.github.rateLimitedUntil = Date.UTC(2026, 10, 29, 15, 42)
    await app.releases.open(true)
    expect(app.check()).toEqual({ kind: 'rate-limited', retryAt: Date.UTC(2026, 10, 29, 15, 42) })
  })

  it('check.newer-major-not-downloaded: 2.0.0 out with 1.0.1 saved → reported, never downloaded', async () => {
    const app = await withSaved(['1.0.1'])
    app.github.publish(buildRelease('2.0.0'), { date: '2027-01-03T10:00:00Z' })
    await app.releases.checkNow()
    expect(app.github.requests).toEqual([RELEASES_URL])
    expect(app.releases.checkState().newerMajor).toEqual({
      version: '2.0.0',
      date: Date.parse('2027-01-03T10:00:00Z')
    })
    expect(app.releases.latest()?.version).toBe('1.0.1')
    expect(app.cached()).toEqual(['1.0.1'])
    expect((await app.releases.getFile({ kind: 'release', version: '1.0.1' }, USB_UF2)).ok).toBe(
      true
    )

    // 1.0.2 and 2.0.0 both out: 1.0.2 is downloaded, 2.0.0 is reported.
    app.github.publish(buildRelease('1.0.2'))
    await app.releases.checkNow()
    expect(app.cached()).toEqual(['1.0.2', '1.0.1'])
    expect(app.releases.checkState().newerMajor?.version).toBe('2.0.0')
    expect(app.github.assetRequests().some((u) => u.includes('2.0.0'))).toBe(false)
  })
})

describe('the download', () => {
  it('download.sha-mismatch: the zip’s SHA-256 is wrong → refused, nothing saved, no temp files, error row', async () => {
    const app = launch()
    const r = buildRelease('0.3.0', {
      manifest: (m) => void ((m.zip as { sha256: string }).sha256 = '0'.repeat(64))
    })
    app.github.publish(r)
    await app.releases.open(true)
    expect(app.check()).toEqual({ kind: 'download-failed', version: '0.3.0' })
    expect(app.cached()).toEqual([])
    expect(app.onDisk()).toEqual([])
    expect(app.rows).toEqual([
      {
        severity: 'error',
        tag: 'Firmware 0.3.0',
        message:
          'Firmware 0.3.0 couldn’t be downloaded: its SHA-256 doesn’t match the release’s manifest.'
      }
    ])
  })

  it('download.cut-off: the download ends early → refused as above', async () => {
    const app = launch()
    const r = buildRelease('0.3.0')
    app.github.publish(r)
    app.github.cutOff.add(
      'https://github.com/OpenSkyHawk/OpenSkyhawk/releases/download/firmware-v0.3.0/openskyhawk-firmware-0.3.0.zip'
    )
    await app.releases.open(true)
    expect(app.check()).toEqual({ kind: 'download-failed', version: '0.3.0' })
    expect(app.cached()).toEqual([])
    expect(app.onDisk()).toEqual([])
    expect(app.rows.map((r) => r.message)).toEqual([
      'Firmware 0.3.0 couldn’t be downloaded: the download was cut off.'
    ])
  })

  it('download.disk-full: a write fails ENOSPC → disk state, no temp files, error row, still working', async () => {
    let full = true
    const fs = failing({
      writeFile: (p) => (full && p.includes('gateway') ? fsError('ENOSPC', p) : undefined)
    })
    const app = launch({ fs })
    const r = buildRelease('0.3.0')
    app.github.publish(r)
    await app.releases.open(true)
    const needed = r.zip.length + unpackedSize(r)
    expect(app.check()).toEqual({ kind: 'disk-full', version: '0.3.0', neededBytes: needed })
    expect(app.cached()).toEqual([])
    expect(app.onDisk()).toEqual([])
    expect(app.rows).toHaveLength(1)
    expect(app.rows[0]).toMatchObject({ severity: 'error', tag: 'Firmware 0.3.0' })
    expect(app.rows[0].message).toMatch(
      /^Not enough space to save firmware 0\.3\.0 \(\d\.\d MB needed\): /
    )

    full = false
    await app.releases.checkNow()
    expect(app.check()).toEqual({ kind: 'ok' })
    expect(app.cached()).toEqual(['0.3.0'])
  })

  it('a folder that isn’t writable → couldn’t be saved', async () => {
    const fs = failing({ mkdir: (p) => fsError('EACCES', p) })
    const app = launch({ fs })
    app.github.publish(buildRelease('0.3.0'))
    await app.releases.open(true)
    expect(app.check()).toEqual({ kind: 'not-saved', version: '0.3.0' })
    expect(app.rows[0].message).toMatch(/^Firmware 0\.3\.0 couldn’t be saved: permission denied/)
  })
})

describe('unpacking', () => {
  /** Publish `r`, check, and expect it refused with nothing kept anywhere. */
  async function refused(r: BuiltRelease) {
    const app = launch()
    app.github.publish(r)
    await app.releases.open(true)
    expect(app.check()).toEqual({ kind: 'download-failed', version: r.version })
    expect(app.cached()).toEqual([])
    expect(app.onDisk()).toEqual([])
    // Nothing written outside the firmware folder but the check's own file.
    for (const n of readdirSync(app.dir)) expect(['firmware', 'release-check.json']).toContain(n)
    return app
  }

  it.each([
    ['openskyhawk-firmware-0.3.0/../evil'],
    ['/evil'],
    ['openskyhawk-firmware-0.3.0\\evil'],
    ['C:evil'],
    ['elsewhere/evil']
  ])('unpack.zip-slip: an entry %s → the whole version refused, nothing written', async (name) => {
    const app = await refused(
      buildRelease('0.3.0', { entries: (e) => void (e[name] = new TextEncoder().encode('x')) })
    )
    expect(app.rows[0].message).toContain(`the zip entry ${name}`)
    expect(existsSync(join(app.dir, 'evil'))).toBe(false)
  })

  it('unpack.manifest-path-refused: a manifest path breaking the same rule → refused', async () => {
    const app = launch()
    app.github.publish(
      buildRelease('0.3.0', {
        manifest: (m) => void (m.files[0].path = 'openskyhawk-firmware-0.3.0/../gateway-0.3.0.uf2')
      })
    )
    await app.releases.open(true)
    // A manifest that breaks the rule isn't a manifest for this release: skipped, warn row.
    expect(app.cached()).toEqual([])
    expect(app.onDisk()).toEqual([])
    expect(app.check()).toEqual({ kind: 'no-release' })
    expect(app.rows[0]).toMatchObject({ severity: 'warn', tag: 'Firmware 0.3.0' })
  })

  it('unpack.file-mismatch: an unpacked file that doesn’t match its entry → not put in place', async () => {
    const app = await refused(
      buildRelease('0.3.0', {
        entries: (e) => {
          const k = 'openskyhawk-firmware-0.3.0/pdu-left/pdu-left-0.3.0.bin'
          e[k] = e[k].slice()
          e[k][10] ^= 0xff
        }
      })
    )
    expect(app.rows[0].message).toBe(
      'Firmware 0.3.0 couldn’t be downloaded: pdu-left-0.3.0.bin does not match the manifest.'
    )
  })

  it('unpack.extras-kept: READMEs, CHANGES.md and LICENSE kept; the inner manifest not written over the flat one', async () => {
    const app = launch()
    const r = buildRelease('0.3.0')
    app.github.publish(r)
    await app.releases.open(true)
    for (const f of [
      'README.md',
      'CHANGES.md',
      'LICENSE',
      'gateway/README.md',
      'pdu-left/README.md'
    ]) {
      expect(existsSync(app.fw('0.3.0', f)), f).toBe(true)
    }
    const flat = JSON.parse(readFileSync(app.fw('0.3.0', 'manifest.json'), 'utf8'))
    expect(flat.zip).toEqual(r.manifest.zip)
  })
})

describe('the start scan', () => {
  it('cache.scan: no manifest, a broken one, a folder/version mismatch → dropped, warn rows; leftovers deleted', async () => {
    const first = await withSaved(['0.3.0', '0.4.0'])
    const fw = first.fw
    // 0.5.0: no manifest. 0.6.0: a manifest that doesn't parse. 0.7.0: 0.4.0's manifest.
    for (const v of ['0.5.0', '0.6.0', '0.7.0']) await fsp.mkdir(fw(v))
    writeFileSync(fw('0.6.0', 'manifest.json'), '{ not json')
    writeFileSync(fw('0.7.0', 'manifest.json'), readFileSync(fw('0.4.0', 'manifest.json')))
    writeFileSync(fw('.tmp-0.8.0.zip'), 'partial')
    await fsp.mkdir(fw('.tmp-0.8.0'))

    const app = first.relaunch()
    await app.releases.open(false)
    expect(app.cached()).toEqual(['0.4.0', '0.3.0'])
    expect(app.onDisk()).toEqual(['0.3.0', '0.4.0'])
    expect(app.rows.map((r) => [r.severity, r.message])).toEqual([
      ['warn', 'Dropped the saved firmware folder 0.5.0: it has no manifest.'],
      ['warn', 'Dropped the saved firmware folder 0.6.0: its manifest does not parse.'],
      [
        'warn',
        'Dropped the saved firmware folder 0.7.0: its manifest is not for this folder (its version is 0.4.0).'
      ]
    ])
    expect(app.releases.state().emptied).toBe(false)
  })

  it('every folder dropped → emptied', async () => {
    const first = await withSaved(['0.3.0'])
    rmSync(first.fw('0.3.0', 'manifest.json'))
    const app = first.relaunch()
    await app.releases.open(false)
    expect(app.releases.state()).toMatchObject({ cached: [], emptied: true, canClear: false })
  })
})

describe('getFile', () => {
  const v030 = { kind: 'release', version: '0.3.0' } as const

  it('getfile.damaged-extracted-file: a flipped byte → downloaded and unpacked once, then served; offline → damaged', async () => {
    const app = await withSaved(['0.3.0'])
    const path = app.fw('0.3.0', 'gateway', 'gateway-0.3.0.uf2')
    const flip = () => {
      const b = readFileSync(path)
      b[100] ^= 0xff
      writeFileSync(path, b)
    }
    flip()
    const got = await app.releases.getFile(v030, USB_UF2)
    expect(got.ok).toBe(true)
    expect(app.github.assetRequests()).toEqual([
      'https://github.com/OpenSkyHawk/OpenSkyhawk/releases/download/firmware-v0.3.0/openskyhawk-firmware-0.3.0.zip'
    ])
    expect(app.github.apiRequests()).toBe(0)

    flip()
    app.github.offline = true
    expect(await app.releases.getFile(v030, USB_UF2)).toEqual({
      ok: false,
      error: 'damaged',
      message: 'The saved copy of firmware 0.3.0 is damaged and couldn’t be downloaded again.'
    })
  })

  it('getfile.damaged-extracted-file: still damaged after the repair → damaged', async () => {
    const app = await withSaved(['0.3.0'])
    writeFileSync(app.fw('0.3.0', 'gateway', 'gateway-0.3.0.uf2'), 'nope')
    // GitHub now serves a zip that doesn't match the saved manifest's record.
    app.github.releases[0].assets.set('openskyhawk-firmware-0.3.0.zip', new Uint8Array([1, 2, 3]))
    const got = await app.releases.getFile(v030, USB_UF2)
    expect(got.ok === false && got.error).toBe('damaged')
    expect(app.cached()).toEqual(['0.3.0'])
  })

  it('getfile.missing-file: an unpacked file deleted by hand → repaired', async () => {
    const app = await withSaved(['0.3.0'])
    rmSync(app.fw('0.3.0', 'pdu-left', 'pdu-left-0.3.0.bin'))
    const got = await app.releases.getFile(v030, { nodeId: 3, format: 'bin' })
    expect(got.ok && got.entry.name).toBe('pdu-left-0.3.0.bin')
    expect(existsSync(app.fw('0.3.0', 'pdu-left', 'pdu-left-0.3.0.bin'))).toBe(true)
    expect(app.onDisk()).toEqual(['0.3.0'])
  })

  it('getfile.not-cached: a version not saved → not-cached, no download', async () => {
    const app = await withSaved(['0.3.0'])
    expect(await app.releases.getFile({ kind: 'release', version: '1.0.1' }, USB_UF2)).toEqual({
      ok: false,
      error: 'not-cached',
      message: 'Firmware 1.0.1 isn’t on this computer.'
    })
    expect(app.github.requests).toEqual([])
  })

  it('getfile.no-image: a PanelGroup NODE_ID → no-image', async () => {
    const app = await withSaved(['0.3.0'])
    expect(await app.releases.getFile(v030, { nodeId: 20, format: 'bin' })).toEqual({
      ok: false,
      error: 'no-image',
      message: 'Firmware 0.3.0 has no image for this board.'
    })
  })

  it('getfile.ambiguous: node 0 elf without board → ambiguous; with board gateway → the app .elf', async () => {
    const app = await withSaved(['0.3.0'])
    const bare = await app.releases.getFile(v030, { nodeId: 0, format: 'elf' })
    expect(bare.ok === false && bare.error).toBe('ambiguous')
    const app0 = await app.releases.getFile(v030, { nodeId: 0, format: 'elf', board: 'gateway' })
    expect(app0.ok && app0.entry.name).toBe('gateway-bridge-0.3.0.elf')
  })

  it('imagefor.no-read: the entry or no-image from the manifest only — no image read, no SHA, no request', async () => {
    const app = await withSaved(['0.3.0'])
    let reads = 0
    const counting = failing({ readFile: () => void reads++ })
    const again = app.relaunch(counting)
    await again.releases.open(false)
    reads = 0
    rmSync(again.fw('0.3.0', 'gateway', 'gateway-0.3.0.uf2'))
    const hit = again.releases.imageFor('0.3.0', USB_UF2)
    expect(hit.ok && hit.entry).toMatchObject({
      name: 'gateway-0.3.0.uf2',
      side: 'usb',
      size: UF2_SIZE_030
    })
    expect(again.releases.imageFor('0.3.0', { nodeId: 20, format: 'bin' })).toMatchObject({
      ok: false,
      error: 'no-image'
    })
    expect(again.releases.imageFor('1.0.1', USB_UF2)).toMatchObject({
      ok: false,
      error: 'not-cached'
    })
    expect(reads).toBe(0)
    expect(again.github.requests).toEqual([])
  })
})

describe('retention and Clear', () => {
  it('retention.newest-five: a 6th version arrives → the oldest is deleted', async () => {
    const app = await withSaved(['0.3.0', '0.4.0', '0.5.0', '0.6.0', '0.7.0'])
    expect(app.cached()).toHaveLength(5)
    app.github.publish(buildRelease('0.8.0'))
    await app.releases.checkNow()
    expect(app.cached()).toEqual(['0.8.0', '0.7.0', '0.6.0', '0.5.0', '0.4.0'])
    expect(app.onDisk()).toEqual(['0.4.0', '0.5.0', '0.6.0', '0.7.0', '0.8.0'])
  })

  it('retention.reading-file-kept: the oldest is being read → kept until the next pass', async () => {
    const first = await withSaved(['0.3.0', '0.4.0', '0.5.0', '0.6.0', '0.7.0'])
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const app = first.relaunch(
      failing({ readFile: (p) => (p.includes('0.3.0/gateway') ? held : undefined) })
    )
    await app.releases.open(false)
    const reading = app.releases.getFile({ kind: 'release', version: '0.3.0' }, USB_UF2)
    expect(app.releases.state().canClear).toBe(false)

    app.github.publish(buildRelease('0.8.0'))
    await app.releases.checkNow()
    expect(app.cached()).toContain('0.3.0')
    expect(app.onDisk()).toContain('0.3.0')

    release()
    expect((await reading).ok).toBe(true)
    expect(app.cached()).toEqual(['0.8.0', '0.7.0', '0.6.0', '0.5.0', '0.4.0'])
    expect(app.onDisk()).not.toContain('0.3.0')
    expect(app.releases.state().canClear).toBe(true)
  })

  it('retention.locked-folder-retried: a delete fails → the folder stays, deleted on the next pass', async () => {
    const first = await withSaved(['0.3.0', '0.4.0', '0.5.0', '0.6.0', '0.7.0'])
    let locked = true
    const app = first.relaunch(
      failing({ rm: (p) => (locked && p.endsWith('0.3.0') ? fsError('EBUSY', p) : undefined) })
    )
    await app.releases.open(false)
    app.github.publish(buildRelease('0.8.0'))
    await app.releases.checkNow()
    expect(app.onDisk()).toContain('0.3.0')
    expect(app.cached()).toContain('0.3.0')

    locked = false
    app.github.publish(buildRelease('0.9.0'))
    await app.releases.checkNow()
    expect(app.cached()).toEqual(['0.9.0', '0.8.0', '0.7.0', '0.6.0', '0.5.0'])
    expect(app.onDisk()).toEqual(['0.5.0', '0.6.0', '0.7.0', '0.8.0', '0.9.0'])
  })

  it('Clear removes every saved release, keeps the last check, and the next check downloads again', async () => {
    const app = await withSaved(['0.3.0', '0.4.0'])
    const last = app.releases.state().last
    expect(await app.releases.clear()).toBe(true)
    expect(app.releases.state()).toMatchObject({
      cached: [],
      cachedBytes: 0,
      emptied: true,
      canClear: false,
      last
    })
    expect(app.onDisk()).toEqual([])
    expect(await app.releases.clear()).toBe(false) // nothing saved: refused

    await app.releases.checkNow()
    expect(app.cached()).toEqual(['0.4.0'])
    expect(app.releases.state().emptied).toBe(false)
  })

  it('Clear is refused while an update reads a file', async () => {
    const first = await withSaved(['0.3.0'])
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const app = first.relaunch(
      failing({ readFile: (p) => (p.endsWith('.uf2') ? held : undefined) })
    )
    await app.releases.open(false)
    const reading = app.releases.getFile({ kind: 'release', version: '0.3.0' }, USB_UF2)
    expect(app.pushes.at(-1)?.canClear).toBe(false)
    expect(await app.releases.clear()).toBe(false)
    release()
    await reading
    expect(app.pushes.at(-1)?.canClear).toBe(true)
  })

  it('cachedVersions: version, release date and size on disk, newest first', async () => {
    const app = await withSaved(['0.3.0', '0.4.0'])
    const list = app.releases.cachedVersions()
    expect(list.map((c) => c.version)).toEqual(['0.4.0', '0.3.0'])
    expect(list[0].date).toBe(Date.parse('2026-10-27T18:06:20Z'))
    // The size on disk is what a fresh scan of the folder counts.
    const again = app.relaunch()
    await again.releases.open(false)
    expect(again.releases.cachedVersions()).toEqual(list)
    expect(again.releases.state().cachedBytes).toBe(list[0].bytes + list[1].bytes)
  })
})
