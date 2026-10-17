import { useConfigStore } from '../../config'
import { RelayPill as Pill } from '../../dcs'

/** The title-bar Relay pill (dcs), with the settings its tooltip names: auto-connect, host, port. */
export function RelayPill() {
  const autoConnect = useConfigStore((s) => s.autoConnect)
  const host = useConfigStore((s) => s.host)
  const port = useConfigStore((s) => s.port)
  return <Pill autoConnect={autoConnect} host={host} port={port} />
}
