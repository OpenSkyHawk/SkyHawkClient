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
      // The only row with an Update today is the Gateway's USB side (#173).
      onUpdate={(row) => row === 'usb' && openUpdate({ kind: 'usb' })}
    />
  )
}
