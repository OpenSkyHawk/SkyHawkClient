import { releaseCard, useReleasesStore } from '../../releases'
import { useNow } from '../kit'

/**
 * The Firmware sheet's release card (#173 draws it; the words are #192's `releaseCard`): the
 * latest release, the check's state and *Check for updates*. Main pushes the state
 * (`releases:state`); this only words it.
 */
export function ReleaseCard() {
  const releases = useReleasesStore((s) => s.releases)
  const checkReleases = useReleasesStore((s) => s.checkReleases)
  // "checked 2 min ago" moves on by itself.
  const now = useNow(!!releases.last, 30_000)
  const card = releaseCard(releases, now)
  return (
    <div className="fw__rel">
      <div>
        <b>{card.head}</b>
        {card.sub && (
          <>
            <br />
            <span>{card.sub}</span>
          </>
        )}
      </div>
      <button className="toolbtn" disabled={card.busy} onClick={checkReleases}>
        {card.button}
      </button>
    </div>
  )
}
