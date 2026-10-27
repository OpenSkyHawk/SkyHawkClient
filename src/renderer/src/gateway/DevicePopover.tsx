import { useEffect, useRef } from 'react'
import { useNav } from '../app/kit'
import { useGatewayStore } from './store'
import { deviceView, linkButton } from './link-view'
import { gatewayFirmwareView, gatewayView } from './gateway-view'

/**
 * The title-bar Device indicator (#69) and its popover: the link state at a glance on every tab,
 * with the same Connect / Disconnect / Retry as the Connection tab's device card. While connected
 * it also shows the Gateway's own health (#94): gold "!" when it reports a problem but still works,
 * red "!" when panel input can't reach DCS. `autoConnect` is Settings' (the title bar hands it in).
 */
export function DevicePopover({ autoConnect }: { autoConnect: boolean }) {
  const deviceState = useGatewayStore((s) => s.deviceState)
  const devicePort = useGatewayStore((s) => s.devicePort)
  const deviceDetail = useGatewayStore((s) => s.deviceDetail)
  const deviceGateway = useGatewayStore((s) => s.deviceGateway)
  const deviceAction = useGatewayStore((s) => s.deviceAction)
  const deviceBusy = useGatewayStore((s) => s.deviceBusy)
  const connectDevice = useGatewayStore((s) => s.connectDevice)
  const disconnectDevice = useGatewayStore((s) => s.disconnectDevice)
  const open = useNav((s) => s.devicePopOpen)
  const set = useNav((s) => s.set)
  const btn = useRef<HTMLButtonElement>(null)

  const dev = deviceView(deviceState, {
    port: devicePort,
    detail: deviceDetail,
    busy: deviceBusy,
    autoConnect
  })
  const button = linkButton(deviceAction)
  const gw = gatewayView(deviceGateway, devicePort)
  const fw = gatewayFirmwareView(deviceGateway?.firmware)
  const cls = gw.pill?.cls ?? dev.cls
  const meta = gw.meta ?? dev.popMeta

  const close = (): void => {
    set({ devicePopOpen: false })
    btn.current?.focus() // back to where the keyboard user was
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      set({ devicePopOpen: false })
      btn.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, set])

  return (
    <span className="devpop-wrap">
      <button
        ref={btn}
        className={`devind ${cls}`}
        title={gw.pill?.tip ?? dev.tip}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => set({ devicePopOpen: !open })}
      >
        {gw.pill && (
          <span className="pill__sym" aria-hidden="true">
            !
          </span>
        )}
        <span className="devind__dot" />
        {dev.label}
      </button>
      {open && (
        <>
          <div className="devpop__scrim" onClick={close} />
          <div className="devpop" role="dialog" aria-label="Device link">
            <div className="devpop__st">
              <span className={`devind devind--bare ${cls}`}>
                <span className="devind__dot" />
              </span>
              {gw.title ?? dev.chip}
            </div>
            {meta && <div className="devpop__meta">{meta}</div>}
            {(gw.health || fw) && (
              <div className="gw">
                {gw.health && (
                  <div className="gw__row">
                    <span className="gw__k">Health</span>
                    <span className={`gw__v${gw.health.tone ? ` gw--${gw.health.tone}` : ''}`}>
                      {gw.health.text}
                    </span>
                  </div>
                )}
                {gw.health?.note && <div className="gw__note">{gw.health.note}</div>}
                {fw && (
                  <div className="gw__row">
                    <span className="gw__k">Firmware</span>
                    <span className={`gw__v${fw.warn ? ' gw--warn' : ''}`}>{fw.pop}</span>
                  </div>
                )}
              </div>
            )}
            <div className="devpop__acts">
              <button
                className={button.action === 'disconnect' ? 'toolbtn' : 'browse'}
                disabled={button.disabled}
                // Focus lands on the action, so Enter/Space work straight after opening.
                autoFocus
                onClick={() =>
                  button.action === 'disconnect' ? disconnectDevice() : connectDevice()
                }
              >
                {button.label}
              </button>
              <button
                className="devpop__link"
                onClick={() => set({ tab: 'connection', devicePopOpen: false })}
              >
                Connection tab →
              </button>
            </div>
          </div>
        </>
      )}
    </span>
  )
}
