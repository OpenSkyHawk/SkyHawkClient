import { useGatewayStore } from './store'
import { clientTooOld } from './gateway-view'

/** Where a newer client is published (the "Get the latest client" link). */
const RELEASES = 'https://github.com/OpenSkyHawk/SkyHawkClient/releases'

/**
 * The client-too-old banner (#171), under the tab bar on every tab while this Gateway is connected:
 * its firmware is on a newer major than this client was built for, so some status may be missing or
 * wrong. Not dismissible. `device:status` carries the Gateway's status only while the link is up.
 */
export function ClientTooOld() {
  const old = useGatewayStore((x) => clientTooOld(x.deviceGateway?.firmware))
  if (!old) return null
  return (
    <div className="appalert" role="alert">
      <span className="appalert__sym" aria-hidden="true">
        !
      </span>
      <span>
        <b>This client is too old for the Gateway’s firmware.</b> The Gateway runs {old.gateway};
        OpenSkyhawk Client v{__APP_VERSION__} supports firmware {old.supported}. Some status may be
        missing or wrong until you update the client.
      </span>
      <a href={RELEASES} target="_blank" rel="noreferrer">
        Get the latest client
      </a>
    </div>
  )
}
