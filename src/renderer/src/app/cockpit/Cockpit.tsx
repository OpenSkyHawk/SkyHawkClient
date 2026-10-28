import { useConfigStore } from '../../config'
import { CockpitTab } from '../../nodes'
import { ReleaseCard } from './ReleaseCard'

/**
 * The Cockpit tab (nodes), drawn against the PSU setting as main resolves it (config), with the
 * Firmware sheet's release card (releases).
 */
export function Cockpit() {
  // The PSU setting as main resolves it (`config:changed`, R3.3).
  const psuView = useConfigStore((s) => s.psuView)
  return <CockpitTab psuView={psuView} releaseCard={<ReleaseCard />} />
}
