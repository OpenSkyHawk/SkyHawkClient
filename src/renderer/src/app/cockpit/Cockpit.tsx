import { useConfigStore } from '../../config'
import { CockpitTab } from '../../nodes'

/** The Cockpit tab (nodes), drawn against the PSU setting as main resolves it (config). */
export function Cockpit() {
  // The PSU setting as main resolves it (`config:changed`, R3.3).
  const psuView = useConfigStore((s) => s.psuView)
  return <CockpitTab psuView={psuView} />
}
