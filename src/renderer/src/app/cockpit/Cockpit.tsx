import { useConfigStore } from '../../config'
import { CockpitTab } from '../../nodes'
import { useUpdateStore } from '../../update'
import { ReleaseCard } from './ReleaseCard'

/**
 * The Cockpit tab (nodes), drawn against the PSU setting as main resolves it (config), with the
 * Firmware sheet's release card (releases) and its rows' *Update* (update).
 */
export function Cockpit() {
  // The PSU setting as main resolves it (`config:changed`, R3.3).
  const psuView = useConfigStore((s) => s.psuView)
  const openUpdate = useUpdateStore((s) => s.openUpdate)
  return (
    <CockpitTab
      psuView={psuView}
      releaseCard={<ReleaseCard />}
      // The Gateway's USB side (#173) and its cockpit side (#187). The cockpit side's *Update*
      // opens the USB side's first while that is behind the release: it carries the newer one.
      onUpdate={(row, action) => {
        if (row === 'usb' || action === 'usb-first') openUpdate({ kind: 'usb' })
        else if (row === 'cockpit') openUpdate({ kind: 'cockpit' })
      }}
    />
  )
}
