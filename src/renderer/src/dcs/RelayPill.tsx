import { deviceView } from '../gateway'
import { useDcsStore } from './store'
import { relaySide, relayTip } from './relay-view'

/**
 * The title-bar Relay pill (#69): the one on/off for the DCS-BIOS stream.
 *
 * Green while delivering end to end, gold while running but waiting, grey when stopped. Start
 * always starts (#159): with no board for a mode that needs one, it runs gold and its tooltip says
 * it waits for the Gateway. What each of those is, main decides (`relay:facts`, R3.3), the
 * endpoint included (X9); the pill words it. `autoConnect` is Settings' (the title bar hands it in).
 */
export function RelayPill({ autoConnect }: { autoConnect: boolean }) {
  const relaying = useDcsStore((s) => s.relaying)
  const facts = useDcsStore((s) => s.relayFacts)
  const toggleRelay = useDcsStore((s) => s.toggleRelay)

  // The side of the on/off the pill shows: a click's pending Start or Stop reads at once.
  const side = relaySide(facts, relaying)
  const waiting = side.waiting !== 'none'
  const title = relayTip({
    tip: side.tip,
    stream: facts.stream,
    deviceLabel: deviceView(facts.deviceState, { autoConnect }).label,
    endpoint: facts.endpoint,
    replayFile: facts.replay?.file
  })

  const cls = relaying ? `pill--on${waiting ? ' pill--wait' : ''}` : ''

  return (
    <span className="devpop-wrap">
      <button className={`pill pill--btn ${cls}`} title={title} onClick={() => toggleRelay()}>
        <span className="pill__dot" />
        <span className="pill__txt">{relaying ? 'Relaying' : 'Stopped'}</span>
      </button>
    </span>
  )
}
