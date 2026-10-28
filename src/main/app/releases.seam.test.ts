// SESSION-seam tests for the firmware release check and the saved releases (#192), through the
// services harness: a fake GitHub answers the release check, and the test reads only pushes,
// intents, requests and the files main leaves under <userData>.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CTRL } from '@shared/app'
import { DEFAULT_CONFIG } from '@shared/config'
import { makeServices, type Services } from '../test-harness/services'

// After the harness, so main is loaded against its fakes.
const { buildRelease, FakeGitHub, UF2_SIZE_030 } = await import('../../test-fixtures/releases')

/** The state main pushed last. */
const state = (app: Services) => app.lastPush('releases:state')

/** Wait for main's first `releases:state`: the saved releases scanned. */
const scanned = (app: Services) =>
  vi.waitFor(() => expect(app.pushesOf('releases:state').length).toBeGreaterThan(0))

describe('the release check at launch (#192)', () => {
  it('on a clean <userData>, the setting on: firmware 0.3.0 saved as firmware/0.3.0/, no zip left', async () => {
    const github = new FakeGitHub()
    const r = buildRelease('0.3.0')
    github.publish(r)
    let answer!: () => void
    github.gate = new Promise((go) => (answer = go))
    const app = makeServices({ github: github.fetch })
    await vi.waitFor(() => expect(state(app)?.check).toEqual({ kind: 'checking' }))
    // Check now while the launch check waits for GitHub: it joins it.
    const joined = app.invoke(CTRL.releasesCheck)
    answer()
    await joined

    expect(github.apiRequests()).toBe(1)
    expect(state(app)).toMatchObject({
      check: { kind: 'ok' },
      last: { latest: { version: '0.3.0' } },
      cached: [{ version: '0.3.0' }],
      emptied: false,
      canClear: true
    })
    const fw = join(app.files.dir, 'firmware')
    expect(readdirSync(fw)).toEqual(['0.3.0'])
    expect(readdirSync(join(fw, '0.3.0')).sort()).toEqual([
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
    expect(app.files.json('firmware/0.3.0/manifest.json')).toEqual(r.manifest)
    expect(app.files.text('firmware/0.3.0/gateway/gateway-0.3.0.uf2')?.length).toBe(UF2_SIZE_030)
    expect(app.files.json('release-check.json')).toMatchObject({ latest: { version: '0.3.0' } })
    expect(app.invoke(CTRL.releasesGet)).toEqual(state(app))
  })

  it('the setting off: no request on launch; Check now still checks', async () => {
    const github = new FakeGitHub()
    github.publish(buildRelease('0.3.0'))
    const app = makeServices({
      github: github.fetch,
      paths: { files: { 'config.json': { ...DEFAULT_CONFIG, checkFirmwareOnLaunch: false } } }
    })
    await scanned(app)
    expect(github.requests).toEqual([])
    expect(state(app)?.check).toEqual({ kind: 'never' })

    await app.invoke(CTRL.releasesCheck)
    expect(github.apiRequests()).toBe(1)
    expect(state(app)?.cached.map((c) => c.version)).toEqual(['0.3.0'])
  })

  it('GitHub unreachable at launch: Couldn’t reach GitHub, nothing saved', async () => {
    const app = makeServices()
    await vi.waitFor(() => expect(state(app)?.check).toEqual({ kind: 'offline' }))
    expect(state(app)).toMatchObject({ cached: [], canClear: false })
    expect(app.files.list()).not.toContain('release-check.json')
  })

  it('Clear removes every download and keeps the last check', async () => {
    const github = new FakeGitHub()
    github.publish(buildRelease('0.3.0'))
    const app = makeServices({ github: github.fetch })
    await scanned(app)
    await app.invoke(CTRL.releasesCheck)
    const last = state(app)?.last

    await app.invoke(CTRL.releasesClear)
    expect(state(app)).toMatchObject({ cached: [], emptied: true, canClear: false, last })
    expect(readdirSync(join(app.files.dir, 'firmware'))).toEqual([])
    expect(existsSync(join(app.files.dir, 'release-check.json'))).toBe(true)
  })
})
