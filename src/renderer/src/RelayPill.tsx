import { useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import {
  deviceView,
  relayTip,
  relayWaiting,
  startBlocked,
  startBlockedCallout,
  startBlockedReason
} from './device-view'

/** How long the blocked-Start callout stays up on its own. */
const CALLOUT_MS = 6000

/**
 * The title-bar Relay pill (#69): the one on/off for the DCS-BIOS stream.
 *
 * Green while delivering end to end, gold while running but waiting, grey when stopped. When Start
 * would be refused — no board for a mode that needs one — it says so at a glance with a "!", and a
 * click answers with a callout under the pill: why, and the Connect that fixes it.
 */
export function RelayPill() {
  const sourceMode = useStore((s) => s.sourceMode)
  const relaying = useStore((s) => s.relaying)
  const relayStream = useStore((s) => s.relayStream)
  const deviceState = useStore((s) => s.deviceState)
  const devicePort = useStore((s) => s.devicePort)
  const deviceDetail = useStore((s) => s.deviceDetail)
  const autoConnect = useStore((s) => s.autoConnect)
  const replayDriveSerial = useStore((s) => s.replayDriveSerial)
  const replayFile = useStore((s) => s.replayFile)
  const transport = useStore((s) => s.transport)
  const host = useStore((s) => s.host)
  const port = useStore((s) => s.port)
  const toggleRelay = useStore((s) => s.toggleRelay)
  const connectDevice = useStore((s) => s.connectDevice)
  const [callout, setCallout] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)

  const blocked = !relaying && startBlocked({ mode: sourceMode, replayDriveSerial, deviceState })
  const waiting = relayWaiting({ mode: sourceMode, relaying, stream: relayStream, deviceState })
  const endpoint =
    transport === 'tcp'
      ? `${host}:${port}`
      : transport === 'loop'
        ? '239.255.50.10:5010'
        : 'unicast listen'
  const title = blocked
    ? startBlockedReason(sourceMode)
    : relayTip({
        mode: sourceMode,
        relaying,
        stream: relayStream,
        deviceState,
        deviceLabel: deviceView(deviceState, {
          port: devicePort,
          detail: deviceDetail,
          autoConnect
        }).label,
        endpoint,
        replayFile
      })

  // The board arriving answers the callout; so does it timing out.
  const open = callout && blocked
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => setCallout(false), CALLOUT_MS)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      setCallout(false)
      btn.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const cls = relaying ? `pill--on${waiting ? ' pill--wait' : ''}` : blocked ? 'pill--blocked' : ''

  return (
    <span className="devpop-wrap">
      <button
        ref={btn}
        className={`pill pill--btn ${cls}`}
        aria-disabled={blocked}
        title={title}
        // Not `disabled`: a blocked pill still has to answer a click, with the reason.
        onClick={() => (blocked ? setCallout(true) : toggleRelay())}
      >
        {blocked && (
          <span className="pill__sym" aria-hidden="true">
            !
          </span>
        )}
        <span className="pill__dot" />
        <span className="pill__txt">{relaying ? 'Relaying' : 'Stopped'}</span>
      </button>
      {open && (
        <>
          <div className="devpop__scrim" onClick={() => setCallout(false)} />
          <div className="devpop" role="alertdialog" aria-label="Can't start the relay">
            <div className="devpop__st">
              <span className="pill__sym" aria-hidden="true">
                !
              </span>
              Can&apos;t start the relay
            </div>
            <div className="devpop__meta">{startBlockedCallout(sourceMode)}</div>
            <div className="devpop__acts">
              <button
                className="browse"
                autoFocus
                onClick={() => {
                  // Connects only: Start stays an explicit second step.
                  setCallout(false)
                  connectDevice()
                }}
              >
                Connect
              </button>
              <span className="devpop__hint">then press Start</span>
            </div>
          </div>
        </>
      )}
    </span>
  )
}
