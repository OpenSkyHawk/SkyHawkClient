import { USB_IDENTITY } from '@shared/firmware'
import { hex4 } from '@shared/format'
import { useNav } from '../app/kit'
import { useGatewayStore } from './store'
import { deviceView, linkButton } from './link-view'
import { gatewayFirmwareView } from './gateway-view'

/** `0x2E8A / 0x4134`: the USB ids as the device card prints them. */
const VID_PID = `${hex4(USB_IDENTITY.vid)} / ${hex4(USB_IDENTITY.pid)}`

/**
 * The Connection tab's device card. `autoConnect` is Settings' (the Connection tab hands it in).
 */
export function DeviceCard({ autoConnect }: { autoConnect: boolean }) {
  const linkUp = useGatewayStore((x) => x.linkUp)
  const deviceState = useGatewayStore((x) => x.deviceState)
  const devicePort = useGatewayStore((x) => x.devicePort)
  const deviceDetail = useGatewayStore((x) => x.deviceDetail)
  const deviceBusy = useGatewayStore((x) => x.deviceBusy)
  const deviceAction = useGatewayStore((x) => x.deviceAction)
  const firmware = useGatewayStore((x) => gatewayFirmwareView(x.deviceGateway?.firmware))
  const connectDevice = useGatewayStore((x) => x.connectDevice)
  const disconnectDevice = useGatewayStore((x) => x.disconnectDevice)
  const set = useNav((x) => x.set)

  // The device card shows the link (#69), which is automatic and independent of the relay.
  // Before a SimGateway is found, only the match target (VID/PID) is shown — not real device data.
  const connected = linkUp
  const dev = deviceView(deviceState, {
    port: devicePort,
    detail: deviceDetail,
    busy: deviceBusy,
    autoConnect
  })
  // Connect / Disconnect / Retry, as main offers it for the link's state (R3.4a).
  const button = linkButton(deviceAction)
  const deviceRows = [
    { k: 'Identity', v: connected ? USB_IDENTITY.product : '— no device' },
    { k: 'VID / PID', v: connected ? VID_PID : `${VID_PID} · target` },
    { k: 'Serial port', v: dev.portRow },
    { k: 'Interfaces', v: connected ? 'CDC serial + HID' : '—' },
    // The Gateway's own build, from its status row (#171).
    { k: 'Firmware', v: connected && firmware ? firmware.card : '—' }
  ]

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="dev__head">
        <div className="dev__icon">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#1e8fff"
            strokeWidth="1.6"
          >
            <rect x="4" y="7" width="16" height="11" rx="2" />
            <path d="M9 7V5h6v2M9 18v2M15 18v2" />
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <div className="dev__name">{`${USB_IDENTITY.product} · Gateway`}</div>
          <div className="dev__meta">composite USB · CDC + HID</div>
        </div>
        <span className={`devind ${dev.cls}`} title={dev.tip}>
          <span className="devind__dot" />
          {dev.chip}
        </span>
        <button
          className={button.action === 'disconnect' ? 'toolbtn' : 'browse'}
          style={{ padding: '7px 14px' }}
          disabled={button.disabled}
          onClick={() => (button.action === 'disconnect' ? disconnectDevice() : connectDevice())}
        >
          {button.label}
        </button>
      </div>
      <div className="dev__body">
        {deviceRows.map((d) => (
          <div className="dev__row" key={d.k}>
            <span className="dev__k">{d.k}</span>
            <span className="dev__v">{d.v}</span>
          </div>
        ))}
        {dev.note && (
          <div className="devnote">
            {dev.note}
            {dev.noteSettingsLink && (
              <>
                {' '}
                <button className="devnote__link" onClick={() => set({ tab: 'settings' })}>
                  Settings › Connection
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
