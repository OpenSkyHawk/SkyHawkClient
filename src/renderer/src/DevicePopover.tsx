import { useEffect, useRef } from 'react'
import { useStore } from './store'
import { deviceView } from './device-view'

/**
 * The title-bar Device indicator (#69) and its popover: the link state at a glance on every tab,
 * with the same Connect / Disconnect / Retry as the Connection tab's device card.
 */
export function DevicePopover() {
  const deviceState = useStore((s) => s.deviceState)
  const devicePort = useStore((s) => s.devicePort)
  const deviceDetail = useStore((s) => s.deviceDetail)
  const autoConnect = useStore((s) => s.autoConnect)
  const connectDevice = useStore((s) => s.connectDevice)
  const disconnectDevice = useStore((s) => s.disconnectDevice)
  const set = useStore((s) => s.set)
  const open = useStore((s) => s.devicePopover)
  const setOpen = (v: boolean | ((o: boolean) => boolean)): void =>
    set({ devicePopover: typeof v === 'function' ? v(useStore.getState().devicePopover) : v })
  const btn = useRef<HTMLButtonElement>(null)

  const dev = deviceView(deviceState, { port: devicePort, detail: deviceDetail, autoConnect })

  const close = (): void => {
    setOpen(false)
    btn.current?.focus() // back to where the keyboard user was
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      set({ devicePopover: false })
      btn.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, set])

  return (
    <span className="devpop-wrap">
      <button
        ref={btn}
        className={`devind ${dev.cls}`}
        title={dev.tip}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="devind__dot" />
        {dev.label}
      </button>
      {open && (
        <>
          <div className="devpop__scrim" onClick={close} />
          <div className="devpop" role="dialog" aria-label="Device link">
            <div className="devpop__st">
              <span className={`devind devind--bare ${dev.cls}`}>
                <span className="devind__dot" />
              </span>
              {dev.chip}
            </div>
            <div className="devpop__meta">{dev.popMeta}</div>
            <div className="devpop__acts">
              <button
                className={dev.button.action === 'disconnect' ? 'toolbtn' : 'browse'}
                disabled={dev.button.disabled}
                // Focus lands on the action, so Enter/Space work straight after opening.
                autoFocus
                onClick={() =>
                  dev.button.action === 'disconnect' ? disconnectDevice() : connectDevice()
                }
              >
                {dev.button.label}
              </button>
              <button
                className="devpop__link"
                onClick={() => {
                  set({ tab: 'connection' })
                  setOpen(false)
                }}
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
