import { useEffect, useRef } from 'react'
import { useStore } from './store'
import { deviceView, linkButton } from './device-view'
import { gatewayView } from './gateway-view'

/**
 * The title-bar Device indicator (#69) and its popover: the link state at a glance on every tab,
 * with the same Connect / Disconnect / Retry as the Connection tab's device card. While connected
 * it also shows the Gateway's own health (#94): gold "!" when it reports a problem but still works,
 * red "!" when panel input can't reach DCS.
 */
export function DevicePopover() {
  const deviceState = useStore((s) => s.deviceState)
  const devicePort = useStore((s) => s.devicePort)
  const deviceDetail = useStore((s) => s.deviceDetail)
  const deviceGateway = useStore((s) => s.deviceGateway)
  const deviceAction = useStore((s) => s.deviceAction)
  const deviceBusy = useStore((s) => s.deviceBusy)
  const autoConnect = useStore((s) => s.autoConnect)
  const connectDevice = useStore((s) => s.connectDevice)
  const disconnectDevice = useStore((s) => s.disconnectDevice)
  const open = useStore((s) => s.devicePopOpen)
  const set = useStore((s) => s.set)
  const btn = useRef<HTMLButtonElement>(null)

  const dev = deviceView(deviceState, {
    port: devicePort,
    detail: deviceDetail,
    busy: deviceBusy,
    autoConnect
  })
  const button = linkButton(deviceAction)
  const gw = gatewayView(deviceGateway, devicePort)
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
            {gw.health && (
              <div className="gw">
                <div className="gw__row">
                  <span className="gw__k">Health</span>
                  <span className={`gw__v${gw.health.tone ? ` gw--${gw.health.tone}` : ''}`}>
                    {gw.health.text}
                  </span>
                </div>
                {gw.health.note && <div className="gw__note">{gw.health.note}</div>}
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
