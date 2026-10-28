import { describe, expect, it } from 'vitest'
import { buildRelease } from '../../test-fixtures/releases'
import {
  beyondKept,
  compareVersions,
  imageErrorText,
  matchImage,
  pickReleases,
  readManifest,
  readReleaseList,
  tagVersion,
  zipNameProblem,
  type ManifestFile
} from './release-rules'

const newerThanOne = (v: { major: number }) => v.major > 1

const listed = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  published_at: '2026-10-27T18:06:20Z',
  assets: [],
  ...extra
})

describe('versions', () => {
  it('reads firmware tags only, with no suffix', () => {
    expect(tagVersion('firmware-v1.0.1')).toBe('1.0.1')
    expect(tagVersion('firmware-v1.0.1-rc.1')).toBeUndefined()
    expect(tagVersion('pcb-v9.0.0')).toBeUndefined()
    expect(tagVersion('firmware-v01.0.0')).toBeUndefined()
    expect(tagVersion('v1.0.0')).toBeUndefined()
  })

  it('orders by major, minor, patch — not as text', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.3.0', '1.0.0')).toBeLessThan(0)
  })
})

describe('the releases list', () => {
  it('keeps published firmware releases from 0.3.0 on, and nothing else', () => {
    const list = readReleaseList([
      listed('firmware-v0.3.0'),
      listed('firmware-v0.2.0'),
      listed('pcb-v5.0.0'),
      listed('firmware-v0.4.0', { prerelease: true }),
      listed('firmware-v0.5.0', { draft: true }),
      listed('firmware-v0.6.0-rc.1'),
      listed('firmware-v0.7.0', { published_at: null }),
      'junk'
    ])
    expect(list.map((r) => r.version)).toEqual(['0.3.0'])
    expect(list[0].date).toBe(Date.parse('2026-10-27T18:06:20Z'))
  })

  it('picks the highest by version, whatever the order or the Latest badge', () => {
    const list = readReleaseList([
      listed('firmware-v0.9.0'),
      listed('firmware-v0.10.0'),
      listed('firmware-v0.3.0', { make_latest: 'true' })
    ])
    expect(pickReleases(list, newerThanOne).candidates.map((r) => r.version)).toEqual([
      '0.10.0',
      '0.9.0',
      '0.3.0'
    ])
  })

  it('splits off a newer major: reported, never a candidate', () => {
    const list = readReleaseList([
      listed('firmware-v2.0.0'),
      listed('firmware-v1.0.2'),
      listed('firmware-v2.1.0')
    ])
    const pick = pickReleases(list, newerThanOne)
    expect(pick.candidates.map((r) => r.version)).toEqual(['1.0.2'])
    expect(pick.newerMajor?.version).toBe('2.1.0')
  })
})

describe('the flat manifest', () => {
  const expectFor = { version: '0.3.0', tag: 'firmware-v0.3.0' }

  it('reads schema 2 for its own release', () => {
    const r = buildRelease('0.3.0')
    const read = readManifest(r.manifest, expectFor)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.manifest.files).toHaveLength(15)
    expect(read.manifest.zip).toEqual(r.manifest.zip)
  })

  it.each([
    ['schema 3', (m: Record<string, unknown>) => (m.schema = 3), 'its schema is 3, not 2'],
    [
      'another version',
      (m: Record<string, unknown>) => (m.version = '0.3.1'),
      'its version is 0.3.1'
    ],
    ['another tag', (m: Record<string, unknown>) => (m.tag = 'firmware-v0.3.1'), 'its tag is'],
    ['no zip record', (m: Record<string, unknown>) => delete m.zip, 'no valid zip record']
  ])('refuses %s', (_name, change, reason) => {
    const r = buildRelease('0.3.0', { manifest: change })
    const read = readManifest(r.manifest, expectFor)
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.reason).toContain(reason)
  })

  it('unpack.manifest-path-refused: a manifest path breaking the zip-slip rule is refused', () => {
    for (const path of [
      'openskyhawk-firmware-0.3.0/../evil.bin',
      '/etc/evil.bin',
      'openskyhawk-firmware-0.3.0\\gateway\\x.uf2',
      'C:/evil.bin',
      'elsewhere/evil.bin'
    ]) {
      const r = buildRelease('0.3.0', { manifest: (m) => void (m.files[0].path = path) })
      expect(readManifest(r.manifest, expectFor).ok, path).toBe(false)
    }
  })
})

describe('the zip-slip rule', () => {
  it('refuses .., absolute names, backslashes, drive letters and names outside the top folder', () => {
    const v = '0.3.0'
    expect(zipNameProblem('openskyhawk-firmware-0.3.0/../evil', v)).toBe('contains ..')
    expect(zipNameProblem('/openskyhawk-firmware-0.3.0/x', v)).toBe('is absolute')
    expect(zipNameProblem('openskyhawk-firmware-0.3.0\\x', v)).toBe('contains a backslash')
    expect(zipNameProblem('C:openskyhawk-firmware-0.3.0/x', v)).toBe('is absolute')
    expect(zipNameProblem('other/x', v)).toBe('is not under openskyhawk-firmware-0.3.0/')
    expect(zipNameProblem('openskyhawk-firmware-0.3.0/', v)).toBeUndefined()
    expect(
      zipNameProblem('openskyhawk-firmware-0.3.0/gateway/gateway-0.3.0.uf2', v)
    ).toBeUndefined()
  })
})

describe('which image an update means', () => {
  const files = buildRelease('0.3.0').manifest.files as ManifestFile[]

  it('finds the USB side by side and format', () => {
    const m = matchImage(files, { side: 'usb', format: 'uf2' })
    expect(m.kind === 'ok' && m.entry.name).toBe('gateway-0.3.0.uf2')
  })

  it('a PanelGroup NODE_ID has no image', () => {
    expect(matchImage(files, { nodeId: 20, format: 'bin' })).toEqual({ kind: 'no-image' })
  })

  it('node 0 elf is ambiguous without a board; board breaks the tie', () => {
    expect(matchImage(files, { nodeId: 0, format: 'elf' })).toEqual({ kind: 'ambiguous', count: 2 })
    const m = matchImage(files, { nodeId: 0, format: 'elf', board: 'gateway' })
    expect(m.kind === 'ok' && m.entry.name).toBe('gateway-bridge-0.3.0.elf')
  })
})

describe('retention', () => {
  it('deletes the oldest beyond the newest 5, except a version being read', () => {
    const v = ['0.3.0', '0.4.0', '0.5.0', '0.6.0', '0.7.0', '0.8.0', '0.9.0']
    expect(beyondKept(v, new Set())).toEqual(['0.4.0', '0.3.0'])
    expect(beyondKept(v, new Set(['0.3.0']))).toEqual(['0.4.0'])
    expect(beyondKept(v.slice(0, 5), new Set())).toEqual([])
  })
})

describe('what an update is told', () => {
  it('words each error as the ticket gives it', () => {
    expect(imageErrorText('no-image', '1.0.1')).toBe('Firmware 1.0.1 has no image for this board.')
    expect(imageErrorText('not-cached', '1.0.1')).toBe('Firmware 1.0.1 isn’t on this computer.')
    expect(imageErrorText('damaged', '1.0.1')).toBe(
      'The saved copy of firmware 1.0.1 is damaged and couldn’t be downloaded again.'
    )
    expect(imageErrorText('disk', '1.0.1', { full: true, neededBytes: 2_018_000 })).toBe(
      'Not enough space to save firmware 1.0.1 (2.0 MB needed).'
    )
    expect(imageErrorText('disk', '1.0.1')).toBe('Firmware 1.0.1 couldn’t be saved.')
  })
})
