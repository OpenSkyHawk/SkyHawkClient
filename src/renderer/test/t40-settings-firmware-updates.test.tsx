// T40 — Settings › Cockpit › Firmware updates (#192, settings.rows): the launch check, the latest
// release and the releases saved on this computer, as main pushes them (`releases:state`).
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { RELEASES_STATE_DEFAULT, type ReleaseCheck, type ReleasesState } from '@shared/releases'
import { Settings } from '../src/app/settings/Settings'
import { renderScenario, settle } from './render'
import { connected } from './scenarios'

const RELEASED = new Date(2026, 10, 29, 18, 6).getTime()

/** Main's state after a check 2 minutes ago that found firmware 1.0.1. */
function after(check: ReleaseCheck, extra: Partial<ReleasesState> = {}): ReleasesState {
  return {
    ...RELEASES_STATE_DEFAULT,
    check,
    last: { checkedAt: Date.now() - 2 * 60_000, latest: { version: '1.0.1', date: RELEASED } },
    ...extra
  }
}

const SAVED: Partial<ReleasesState> = {
  cached: [
    { version: '1.0.1', bytes: 1_470_000 },
    { version: '1.0.0', bytes: 1_470_000 },
    { version: '0.3.0', bytes: 1_470_000 }
  ],
  cachedBytes: 4_410_000,
  canClear: true
}

/** Settings on its Cockpit section, with main's release state `releases`. */
async function openFirmwareUpdates(releases?: ReleasesState, checkOnLaunch = true) {
  const r = await renderScenario(<Settings />, {
    device: connected(),
    config: { checkFirmwareOnLaunch: checkOnLaunch },
    ...(releases && { releases })
  })
  await r.user.click(screen.getByRole('button', { name: /^Cockpit/ }))
  await settle()
  const toggle = () => screen.getByRole('button', { name: 'Check for updates on launch' })
  const check = () => screen.getByRole('button', { name: /^(Check now|Checking…|Try again)$/ })
  const clear = () => screen.getByRole('button', { name: 'Clear' })
  return { ...r, toggle, check, clear }
}

describe('T40 Settings › Cockpit › Firmware updates (#192)', () => {
  it('the section as drawn: the toggle, Latest release, Downloaded firmware', async () => {
    await openFirmwareUpdates()
    expect(screen.getByText('Firmware updates')).toBeInTheDocument()
    expect(screen.getByText('not checked')).toBeInTheDocument()
    expect(screen.getByText('Check for updates on launch')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Looks up the latest firmware release on GitHub and saves it on this computer, so updates and rollbacks work offline.'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('Latest release')).toBeInTheDocument()
    expect(screen.getByText('Not checked yet')).toBeInTheDocument()
    expect(screen.getByText('Downloaded firmware')).toBeInTheDocument()
    expect(screen.getByText('Nothing saved yet')).toBeInTheDocument()
  })

  it.each<[string, ReleasesState, string, string]>([
    ['never checked', RELEASES_STATE_DEFAULT, 'Not checked yet', 'Check now'],
    ['checking', after({ kind: 'checking' }), 'Checking GitHub…', 'Checking…'],
    [
      'downloading',
      after({ kind: 'downloading', version: '1.0.1' }),
      'Downloading firmware 1.0.1…',
      'Checking…'
    ],
    [
      'OK',
      after({ kind: 'ok' }),
      'Firmware 1.0.1 · released 29 Nov · checked 2 min ago',
      'Check now'
    ],
    [
      'no release',
      after({ kind: 'no-release' }, { last: { checkedAt: Date.now() - 2 * 60_000 } }),
      'No firmware release found on GitHub · checked 2 min ago',
      'Check now'
    ],
    [
      'offline',
      after({ kind: 'offline' }),
      'Couldn’t reach GitHub · using the last check (firmware 1.0.1, 2 min ago)',
      'Try again'
    ],
    [
      'offline, never checked',
      { ...RELEASES_STATE_DEFAULT, check: { kind: 'offline' } },
      'Couldn’t reach GitHub',
      'Try again'
    ],
    [
      'download failed',
      after({ kind: 'download-failed', version: '1.0.1' }),
      'Firmware 1.0.1 couldn’t be downloaded · it’ll try again on the next check',
      'Check now'
    ],
    [
      'disk full',
      after({ kind: 'disk-full', version: '1.0.1', neededBytes: 2_018_000 }),
      'Not enough space to save firmware 1.0.1 (2.0 MB needed)',
      'Check now'
    ],
    [
      'not writable',
      after({ kind: 'not-saved', version: '1.0.1' }),
      'Firmware 1.0.1 couldn’t be saved',
      'Check now'
    ],
    [
      'newer major',
      after(
        { kind: 'ok' },
        {
          last: {
            checkedAt: Date.now() - 2 * 60_000,
            latest: { version: '1.0.1', date: RELEASED },
            newerMajor: { version: '2.0.0', date: Date.now() }
          }
        }
      ),
      'Firmware 2.0.0 is out — update the client to use it',
      'Check now'
    ]
  ])('Latest release, %s', async (_name, releases, desc, button) => {
    const { check } = await openFirmwareUpdates(releases)
    expect(screen.getByText(desc)).toBeInTheDocument()
    expect(check()).toHaveTextContent(button)
    if (button === 'Checking…') expect(check()).toBeDisabled()
    else expect(check()).toBeEnabled()
  })

  it('the rate-limited state names the reset time', async () => {
    const retryAt = new Date(2026, 10, 30, 15, 42).getTime()
    await openFirmwareUpdates(after({ kind: 'rate-limited', retryAt }))
    expect(
      screen.getByText('GitHub’s limit for checks was reached · try again after 15:42')
    ).toBeInTheDocument()
  })

  it('the header names the latest this client can use, also when a newer major is out', async () => {
    await openFirmwareUpdates(
      after(
        { kind: 'ok' },
        {
          last: {
            checkedAt: Date.now(),
            latest: { version: '1.0.1', date: RELEASED },
            newerMajor: { version: '2.0.0', date: Date.now() }
          }
        }
      )
    )
    expect(screen.getByText('latest 1.0.1')).toBeInTheDocument()
  })

  it('the saved versions, newest first, and their size on disk', async () => {
    const { clear } = await openFirmwareUpdates(after({ kind: 'ok' }, SAVED))
    expect(
      screen.getByText(
        'Firmware 1.0.1, 1.0.0, 0.3.0 · 4.4 MB · kept so updates and rollbacks work offline'
      )
    ).toBeInTheDocument()
    expect(clear()).toBeEnabled()
  })

  it('Clear → main clears → Nothing saved — the next check downloads the latest again', async () => {
    const { sky, user, clear } = await openFirmwareUpdates(after({ kind: 'ok' }, SAVED))
    await user.click(clear())
    expect(sky.clearReleases).toHaveBeenCalledTimes(1)
    sky.emitScenario({ releases: after({ kind: 'ok' }, { emptied: true }) })
    expect(
      screen.getByText('Nothing saved — the next check downloads the latest again')
    ).toBeInTheDocument()
    expect(clear()).toBeDisabled()
  })

  it('Clear is disabled while nothing is saved, and while an update reads a file', async () => {
    const { sky, clear } = await openFirmwareUpdates()
    expect(clear()).toBeDisabled()
    sky.emitScenario({ releases: after({ kind: 'ok' }, { ...SAVED, canClear: false }) })
    expect(clear()).toBeDisabled()
    sky.emitScenario({ releases: after({ kind: 'ok' }, SAVED) })
    expect(clear()).toBeEnabled()
  })

  it('Check now asks main; Checking… follows main’s push, disabled', async () => {
    const { sky, user, check } = await openFirmwareUpdates(after({ kind: 'ok' }))
    await user.click(check())
    expect(sky.checkReleases).toHaveBeenCalledTimes(1)
    sky.emitScenario({ releases: after({ kind: 'checking' }) })
    expect(check()).toHaveTextContent('Checking…')
    expect(check()).toBeDisabled()
    expect(screen.getByText('Checking GitHub…')).toBeInTheDocument()
  })

  it('the launch toggle saves the setting through main', async () => {
    const { sky, user, toggle } = await openFirmwareUpdates()
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    await user.click(toggle())
    expect(sky.editConfig).toHaveBeenLastCalledWith({ checkFirmwareOnLaunch: false })
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    expect(sky.setConfig.mock.lastCall?.[0].checkFirmwareOnLaunch).toBe(false)
  })

  it('the setting off is shown off', async () => {
    const { toggle } = await openFirmwareUpdates(undefined, false)
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
  })
})
