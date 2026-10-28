import { useConfigStore } from '../../config'
import { releaseRows, useReleasesStore } from '../../releases'
import { Row, useNav, useNow } from '../kit'

/**
 * Settings › Cockpit › Firmware updates (#192): the launch check, the latest release and the
 * releases saved on this computer. Main pushes the state (`releases:state`); this only words it.
 */
export function FirmwareUpdates() {
  const on = useConfigStore((s) => s.checkFirmwareOnLaunch)
  const setConfigField = useConfigStore((s) => s.setConfigField)
  const releases = useReleasesStore((s) => s.releases)
  const checkReleases = useReleasesStore((s) => s.checkReleases)
  const clearReleases = useReleasesStore((s) => s.clearReleases)
  const nav = useNav()
  // "checked 2 min ago" moves on by itself.
  const now = useNow(!!releases.last, 30_000)
  const rows = releaseRows(releases, now)

  return (
    <>
      <div className="ig__head">
        <span className="section-h">Firmware updates</span>
        <span className="ig__n">{rows.header}</span>
        {/* The Cockpit's Firmware button lists every board against the release (#173). */}
        <button
          className="toolbtn"
          style={{ marginLeft: 'auto' }}
          title="Opens the Cockpit tab — its Firmware button lists every board"
          onClick={() => nav.set({ tab: 'cockpit' })}
        >
          Open Cockpit →
        </button>
      </div>
      <div className="set-card">
        <Row
          k="Check for updates on launch"
          sub="Looks up the latest firmware release on GitHub and saves it on this computer, so updates and rollbacks work offline."
        >
          <button
            className={`toggle${on ? ' on' : ''}`}
            onClick={() => setConfigField({ checkFirmwareOnLaunch: !on })}
            aria-pressed={on}
            aria-label="Check for updates on launch"
          >
            <span />
          </button>
        </Row>
        <Row k="Latest release" sub={rows.latestDesc}>
          <button className="browse" disabled={rows.checkDisabled} onClick={checkReleases}>
            {rows.checkLabel}
          </button>
        </Row>
        <Row k="Downloaded firmware" sub={rows.cacheDesc}>
          <button className="browse" disabled={rows.clearDisabled} onClick={clearReleases}>
            Clear
          </button>
        </Row>
      </div>
    </>
  )
}
