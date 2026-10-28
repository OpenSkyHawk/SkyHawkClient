import { useDcsStore } from '../../dcs'
import { useReleasesStore } from '../../releases'
import { UpdateDialog } from '../../update'

/**
 * The firmware update dialog (#173), over every tab while an update is open, with what other
 * topics do for it: *Stop relay* (dcs) and *Check for updates* (releases).
 */
export function FirmwareUpdate() {
  const toggleRelay = useDcsStore((s) => s.toggleRelay)
  const checkReleases = useReleasesStore((s) => s.checkReleases)
  const check = useReleasesStore((s) => s.releases.check.kind)
  return (
    <UpdateDialog
      onStopRelay={toggleRelay}
      onCheckReleases={checkReleases}
      checkingReleases={check === 'checking' || check === 'downloading'}
    />
  )
}
