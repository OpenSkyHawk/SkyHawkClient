import { useConfigStore } from '../../config'
import { RelayPill as Pill } from '../../dcs'

/** The title-bar Relay pill (dcs), with the setting its tooltip names: auto-connect. */
export function RelayPill() {
  const autoConnect = useConfigStore((s) => s.autoConnect)
  return <Pill autoConnect={autoConnect} />
}
