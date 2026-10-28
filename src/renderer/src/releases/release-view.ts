// The release check's words (#192), pure: main decides every state (`releases:state`); this only
// words it, for Settings › Cockpit › Firmware updates and for the Firmware sheet's release card
// (#173 draws the card; the copy is #192's, so both surfaces read it from here).
import { ago, dayMonth, hhmm, megabytes } from '@shared/format'
import type { ReleasesState } from '@shared/releases'

const busy = (s: ReleasesState) => s.check.kind === 'checking' || s.check.kind === 'downloading'

/** What the latest release line says for a failed download or save; undefined otherwise. */
function saveFailure(s: ReleasesState): string | undefined {
  const c = s.check
  switch (c.kind) {
    case 'download-failed':
      return `Firmware ${c.version} couldn’t be downloaded · it’ll try again on the next check`
    case 'disk-full':
      return `Not enough space to save firmware ${c.version} (${megabytes(c.neededBytes)} needed)`
    case 'not-saved':
      return `Firmware ${c.version} couldn’t be saved`
    default:
      return undefined
  }
}

/** The newer-major line: a release this client can't use, never downloaded. */
const newerMajorLine = (version: string) =>
  `Firmware ${version} is out — update the client to use it`

/** The four Settings rows' words: the header note, *Latest release*, its button, *Downloaded firmware*. */
export interface ReleaseRows {
  /** Beside the section title: `latest 1.0.1`, `no release` or `not checked`. */
  header: string
  latestDesc: string
  checkLabel: string
  checkDisabled: boolean
  cacheDesc: string
  clearDisabled: boolean
}

export function releaseRows(s: ReleasesState, now: number): ReleaseRows {
  const c = s.check
  const latest = s.last?.latest
  const checked = s.last ? ago(s.last.checkedAt, now) : ''
  let latestDesc: string
  switch (c.kind) {
    case 'never':
      latestDesc = 'Not checked yet'
      break
    case 'checking':
      latestDesc = 'Checking GitHub…'
      break
    case 'downloading':
      latestDesc = `Downloading firmware ${c.version}…`
      break
    case 'ok':
      latestDesc = s.last?.newerMajor
        ? newerMajorLine(s.last.newerMajor.version)
        : latest
          ? `Firmware ${latest.version} · released ${dayMonth(latest.date)} · checked ${checked}`
          : 'Not checked yet'
      break
    case 'no-release':
      latestDesc = `No firmware release found on GitHub · checked ${checked}`
      break
    case 'offline':
      latestDesc = latest
        ? `Couldn’t reach GitHub · using the last check (firmware ${latest.version}, ${checked})`
        : 'Couldn’t reach GitHub'
      break
    case 'rate-limited':
      latestDesc = `GitHub’s limit for checks was reached · try again after ${hhmm(c.retryAt)}`
      break
    default:
      latestDesc = saveFailure(s)!
  }
  const versions = s.cached.map((v) => v.version)
  return {
    header: latest ? `latest ${latest.version}` : s.last ? 'no release' : 'not checked',
    latestDesc,
    checkLabel: busy(s) ? 'Checking…' : c.kind === 'offline' ? 'Try again' : 'Check now',
    checkDisabled: busy(s),
    cacheDesc: versions.length
      ? `Firmware ${versions.join(', ')} · ${megabytes(s.cachedBytes)} · kept so updates and rollbacks work offline`
      : s.emptied
        ? 'Nothing saved — the next check downloads the latest again'
        : 'Nothing saved yet',
    clearDisabled: !s.canClear
  }
}

/** The Firmware sheet's release card (#173 draws it): its two lines and its button. */
export interface ReleaseCard {
  head: string
  sub: string
  button: string
  busy: boolean
}

export function releaseCard(s: ReleasesState, now: number): ReleaseCard {
  const c = s.check
  const latest = s.last?.latest
  const checked = s.last ? `checked ${ago(s.last.checkedAt, now)}` : ''
  const button = busy(s) ? 'Checking…' : c.kind === 'offline' ? 'Try again' : 'Check for updates'
  const card = (head: string, sub: string): ReleaseCard => ({ head, sub, button, busy: busy(s) })
  // Before any check has found a release there is no version to head the card: the state's own
  // words head it.
  const withLatest = (sub: string): ReleaseCard =>
    latest ? card(`Latest firmware ${latest.version}`, sub) : card(sub, '')
  switch (c.kind) {
    case 'never':
      return card('Not checked yet', '')
    case 'checking':
      return withLatest('Checking GitHub…')
    case 'downloading':
      return withLatest(`Downloading firmware ${c.version}…`)
    case 'ok':
      if (s.last?.newerMajor) {
        return card(newerMajorLine(s.last.newerMajor.version), `not downloaded · ${checked}`)
      }
      return latest
        ? card(
            `Latest firmware ${latest.version}`,
            `released ${dayMonth(latest.date)} · ${checked}`
          )
        : card('Not checked yet', '')
    case 'no-release':
      return card('No firmware release found on GitHub', checked)
    case 'offline':
      return latest
        ? card(
            'Couldn’t reach GitHub',
            `using the last check (firmware ${latest.version}, ${ago(s.last!.checkedAt, now)}) · saved firmware still works`
          )
        : card('Couldn’t reach GitHub', 'saved firmware still works')
    case 'rate-limited':
      return withLatest(
        `GitHub’s limit for checks was reached · try again after ${hhmm(c.retryAt)}`
      )
    default:
      return withLatest(saveFailure(s)!)
  }
}
