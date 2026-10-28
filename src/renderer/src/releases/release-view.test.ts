import { describe, expect, it } from 'vitest'
import { RELEASES_STATE_DEFAULT, type ReleaseCheck, type ReleasesState } from '@shared/releases'
import { releaseCard, releaseRows } from './release-view'

const NOW = new Date(2026, 10, 30, 12, 0).getTime()
const RELEASED = new Date(2026, 10, 29, 18, 6).getTime()
const RESET = new Date(2026, 10, 30, 15, 42).getTime()
const min = (n: number) => NOW - n * 60_000

/** A state after a check 2 minutes ago that found firmware 1.0.1. */
function after(check: ReleaseCheck, extra: Partial<ReleasesState> = {}): ReleasesState {
  return {
    ...RELEASES_STATE_DEFAULT,
    check,
    last: { checkedAt: min(2), latest: { version: '1.0.1', date: RELEASED } },
    ...extra
  }
}

const SAVED: Partial<ReleasesState> = {
  cached: [
    { version: '1.0.1', bytes: 2_000_000 },
    { version: '1.0.0', bytes: 1_300_000 },
    { version: '0.3.0', bytes: 1_100_000 }
  ],
  cachedBytes: 4_400_000,
  canClear: true
}

describe('Settings › Cockpit › Firmware updates: every state of the two rows', () => {
  const rows = (s: ReleasesState) => releaseRows(s, NOW)

  it('never checked: Not checked yet · Check now · Nothing saved yet', () => {
    expect(rows(RELEASES_STATE_DEFAULT)).toEqual({
      header: 'not checked',
      latestDesc: 'Not checked yet',
      checkLabel: 'Check now',
      checkDisabled: false,
      cacheDesc: 'Nothing saved yet',
      clearDisabled: true
    })
  })

  it('checking and downloading: Checking…, disabled', () => {
    expect(rows(after({ kind: 'checking' }))).toMatchObject({
      latestDesc: 'Checking GitHub…',
      checkLabel: 'Checking…',
      checkDisabled: true
    })
    expect(rows(after({ kind: 'downloading', version: '1.0.1' }))).toMatchObject({
      latestDesc: 'Downloading firmware 1.0.1…',
      checkLabel: 'Checking…',
      checkDisabled: true
    })
  })

  it('OK: the release, its date and the check; the saved versions and their size', () => {
    expect(rows(after({ kind: 'ok' }, SAVED))).toEqual({
      header: 'latest 1.0.1',
      latestDesc: 'Firmware 1.0.1 · released 29 Nov · checked 2 min ago',
      checkLabel: 'Check now',
      checkDisabled: false,
      cacheDesc:
        'Firmware 1.0.1, 1.0.0, 0.3.0 · 4.4 MB · kept so updates and rollbacks work offline',
      clearDisabled: false
    })
  })

  it('no release found', () => {
    const s = after({ kind: 'no-release' }, { last: { checkedAt: min(2) } })
    expect(rows(s)).toMatchObject({
      header: 'no release',
      latestDesc: 'No firmware release found on GitHub · checked 2 min ago',
      checkLabel: 'Check now'
    })
  })

  it('offline: the last check, or none; Try again', () => {
    const s = after(
      { kind: 'offline' },
      { last: { checkedAt: NOW - 3 * 3_600_000, latest: { version: '1.0.1', date: RELEASED } } }
    )
    expect(rows(s)).toMatchObject({
      latestDesc: 'Couldn’t reach GitHub · using the last check (firmware 1.0.1, 3 h ago)',
      checkLabel: 'Try again'
    })
    expect(rows({ ...RELEASES_STATE_DEFAULT, check: { kind: 'offline' } })).toMatchObject({
      latestDesc: 'Couldn’t reach GitHub',
      checkLabel: 'Try again'
    })
  })

  it('rate-limited: the reset time', () => {
    expect(rows(after({ kind: 'rate-limited', retryAt: RESET }))).toMatchObject({
      latestDesc: 'GitHub’s limit for checks was reached · try again after 15:42',
      checkLabel: 'Check now'
    })
  })

  it('a failed download, a full disk, a folder that can’t be written', () => {
    expect(rows(after({ kind: 'download-failed', version: '1.0.1' })).latestDesc).toBe(
      'Firmware 1.0.1 couldn’t be downloaded · it’ll try again on the next check'
    )
    expect(
      rows(after({ kind: 'disk-full', version: '1.0.1', neededBytes: 2_018_000 })).latestDesc
    ).toBe('Not enough space to save firmware 1.0.1 (2.0 MB needed)')
    expect(rows(after({ kind: 'not-saved', version: '1.0.1' })).latestDesc).toBe(
      'Firmware 1.0.1 couldn’t be saved'
    )
  })

  it('emptied: the next check downloads the latest again', () => {
    expect(rows(after({ kind: 'ok' }, { emptied: true })).cacheDesc).toBe(
      'Nothing saved — the next check downloads the latest again'
    )
  })

  it('Clear is disabled while an update reads a file', () => {
    expect(rows(after({ kind: 'ok' }, { ...SAVED, canClear: false })).clearDisabled).toBe(true)
  })

  it('newer major: the first line only; the header names the latest this client can use', () => {
    const s = after(
      { kind: 'ok' },
      {
        last: {
          checkedAt: min(2),
          latest: { version: '1.0.1', date: RELEASED },
          newerMajor: { version: '2.0.0', date: NOW }
        }
      }
    )
    expect(rows(s)).toMatchObject({
      header: 'latest 1.0.1',
      latestDesc: 'Firmware 2.0.0 is out — update the client to use it',
      checkLabel: 'Check now'
    })
  })
})

describe('the Firmware sheet’s release card: every state', () => {
  const card = (s: ReleasesState) => releaseCard(s, NOW)
  const head = 'Latest firmware 1.0.1'

  it.each<[string, ReleasesState, string, string, string]>([
    ['OK', after({ kind: 'ok' }), head, 'released 29 Nov · checked 2 min ago', 'Check for updates'],
    ['checking', after({ kind: 'checking' }), head, 'Checking GitHub…', 'Checking…'],
    [
      'downloading',
      after({ kind: 'downloading', version: '1.0.1' }),
      head,
      'Downloading firmware 1.0.1…',
      'Checking…'
    ],
    [
      'offline',
      after(
        { kind: 'offline' },
        { last: { checkedAt: NOW - 3 * 3_600_000, latest: { version: '1.0.1', date: RELEASED } } }
      ),
      'Couldn’t reach GitHub',
      'using the last check (firmware 1.0.1, 3 h ago) · saved firmware still works',
      'Try again'
    ],
    [
      'rate-limited',
      after({ kind: 'rate-limited', retryAt: RESET }),
      head,
      'GitHub’s limit for checks was reached · try again after 15:42',
      'Check for updates'
    ],
    [
      'no release',
      after({ kind: 'no-release' }, { last: { checkedAt: min(2) } }),
      'No firmware release found on GitHub',
      'checked 2 min ago',
      'Check for updates'
    ],
    [
      'download failed',
      after({ kind: 'download-failed', version: '1.0.1' }),
      head,
      'Firmware 1.0.1 couldn’t be downloaded · it’ll try again on the next check',
      'Check for updates'
    ],
    [
      'disk full',
      after({ kind: 'disk-full', version: '1.0.1', neededBytes: 2_018_000 }),
      head,
      'Not enough space to save firmware 1.0.1 (2.0 MB needed)',
      'Check for updates'
    ],
    [
      'not writable',
      after({ kind: 'not-saved', version: '1.0.1' }),
      head,
      'Firmware 1.0.1 couldn’t be saved',
      'Check for updates'
    ],
    [
      'newer major',
      after(
        { kind: 'ok' },
        {
          last: {
            checkedAt: min(2),
            latest: { version: '1.0.1', date: RELEASED },
            newerMajor: { version: '2.0.0', date: NOW }
          }
        }
      ),
      'Firmware 2.0.0 is out — update the client to use it',
      'not downloaded · checked 2 min ago',
      'Check for updates'
    ]
  ])('%s', (_name, s, h, sub, button) => {
    expect(card(s)).toMatchObject({ head: h, sub, button })
  })

  it('before any release is known, the state’s own words head the card', () => {
    expect(card(RELEASES_STATE_DEFAULT)).toEqual({
      head: 'Not checked yet',
      sub: '',
      button: 'Check for updates',
      busy: false
    })
    expect(card({ ...RELEASES_STATE_DEFAULT, check: { kind: 'checking' } })).toEqual({
      head: 'Checking GitHub…',
      sub: '',
      button: 'Checking…',
      busy: true
    })
  })
})
