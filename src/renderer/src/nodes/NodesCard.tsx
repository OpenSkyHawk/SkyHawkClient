import { useNav } from '../app/kit'
import { deviceView, useGatewayStore } from '../gateway'
import { useNodesStore } from './store'
import { Dot } from './Dot'

/**
 * Connected nodes (#66): counts and the nodes that need attention, most severe first — the same
 * order as Cockpit › Attention. Healthy nodes are left to the Cockpit tab. `autoConnect` is
 * Settings' (the Connection tab hands it in).
 */
export function NodesCard({ autoConnect }: { autoConnect: boolean }) {
  // Counts and rows as main summed them up (cockpit:snapshot, R3.2b).
  const sum = useNodesStore((x) => x.cockpit.nodesCard)
  const deviceState = useGatewayStore((x) => x.deviceState)
  const openInCockpit = useNav((x) => x.openInCockpit)
  const set = useNav((x) => x.set)
  // Node status rides on the device link, which is up in every source mode (#69).
  const linkUp = useGatewayStore((x) => x.linkUp)

  return (
    <div className="card field ncard">
      <div className="panel-h">
        <span className="section-h">Connected nodes</span>
      </div>
      {!linkUp ? (
        <div className="hint">{deviceView(deviceState, { autoConnect }).nodesHint}</div>
      ) : sum.known === 0 ? (
        <div className="hint">{sum.empty}</div>
      ) : (
        <>
          <div className="nsum">
            <div>
              <b style={{ color: 'var(--green)' }}>{sum.healthy}</b>
              <span>healthy</span>
            </div>
            <div>
              <b style={{ color: 'var(--gold)' }}>{sum.warn}</b>
              <span>warning</span>
            </div>
            <div>
              <b style={{ color: 'var(--red)' }}>{sum.off}</b>
              <span>offline</span>
            </div>
            <div title="Total W the client computes from the PDUs' rail readings">
              <b>{sum.pdus}</b>
              <span>PDUs · {sum.watts === null ? '—' : sum.watts.toFixed(1)} W</span>
            </div>
          </div>
          {sum.rows.length === 0 ? (
            <div className="hint">Nothing needs attention.</div>
          ) : (
            <div className="nodes ncard__rows">
              {sum.rows.map((r) => (
                <div className={`node${r.state === 'off' ? ' node--off' : ''}`} key={r.nodeId}>
                  <Dot state={r.state} />
                  <span className="node__id">{r.name}</span>
                  <span className="node__meta">{r.meta}</span>
                  <span className="node__flags">
                    <b className={`flag flag--${r.tone}`}>{r.chip}</b>
                    <button
                      className="cog"
                      title="Open in Cockpit"
                      aria-label={`Open ${r.name} in Cockpit`}
                      onClick={() => openInCockpit(r.nodeId)}
                    >
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="ncard__foot">
            <span className="hint">{sum.footer}</span>
            <button className="browse" onClick={() => set({ tab: 'cockpit' })}>
              Open Cockpit →
            </button>
          </div>
        </>
      )}
    </div>
  )
}
