import { useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import {
  deviceView,
  endpointText,
  relaySide,
  relayTip,
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
 * click answers with a callout under the pill: why, and the Connect that fixes it. What each of
 * those is, main decides (`relay:facts`, R3.3); the pill words it.
 */
export function RelayPill() {
  const relaying = useStore((s) => s.relaying)
  const facts = useStore((s) => s.relayFacts)
  const autoConnect = useStore((s) => s.autoConnect)
  const host = useStore((s) => s.host)
  const port = useStore((s) => s.port)
  const toggleRelay = useStore((s) => s.toggleRelay)
  const connectDevice = useStore((s) => s.connectDevice)
  const [callout, setCallout] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)

  // The side of the on/off the pill shows: a click's pending Start or Stop reads at once.
  const side = relaySide(facts, relaying)
  const blocked = side.startBlocked
  const waiting = side.waiting !== 'none'
  const title = blocked
    ? startBlockedReason(blocked)
    : relayTip({
        tip: side.tip,
        stream: facts.stream,
        deviceLabel: deviceView(facts.deviceState, { autoConnect }).label,
        endpoint: endpointText(facts.endpoint.pill, host, port),
        replayFile: facts.replay?.file
      })

  // The board arriving answers the callout; so does it timing out.
  const open = callout && !!blocked
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
        aria-disabled={!!blocked}
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
            <div className="devpop__meta">{startBlockedCallout(blocked!)}</div>
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
