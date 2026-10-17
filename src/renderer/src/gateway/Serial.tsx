import { fmtTime } from '@shared/format'
import { useGatewayStore } from './store'
import { render } from './serial-view'

export function Serial() {
  const monitor = useGatewayStore((x) => x.serialMonitor)
  const rows = useGatewayStore((x) => x.serialLog)
  const setSerialMonitor = useGatewayStore((x) => x.setSerialMonitor)
  const clearSerial = useGatewayStore((x) => x.clearSerial)
  const view = rows.slice(0, 1000)

  return (
    <div className="log">
      <div className="log__toolbar">
        <button
          className={`toolbtn${monitor ? ' on' : ''}`}
          onClick={() => setSerialMonitor(!monitor)}
        >
          {monitor ? '● Monitoring' : 'Start monitor'}
        </button>
        <button className="toolbtn" onClick={() => clearSerial()}>
          Clear
        </button>
        <div className="log__tools">
          <span className="hint" style={{ margin: 0 }}>
            {rows.length} frames · TX host→device · RX device→host
          </span>
        </div>
      </div>

      <div className="log__grid ser__grid log__head">
        <span>Time</span>
        <span>Dir</span>
        <span>Bytes (hex)</span>
        <span>ASCII</span>
      </div>

      <div className="log__rows scroll">
        {view.length === 0 ? (
          <div className="hint" style={{ padding: '16px 28px' }}>
            {monitor
              ? 'Monitoring — no serial traffic yet. (TX/RX needs a connected Gateway.)'
              : 'Serial monitor is off. Start it to see raw bytes both ways.'}
          </div>
        ) : (
          view.map((r) => {
            const { hex, ascii, more } = render(r.hex)
            return (
              <div className="log__grid ser__grid log__row" key={r.id}>
                <span className="log__time">{fmtTime(r.t)}</span>
                <span
                  className="log__dir"
                  style={{ color: r.dir === 'tx' ? 'var(--blue)' : 'var(--green)' }}
                >
                  {r.dir === 'tx' ? 'TX ▸' : '◂ RX'}
                </span>
                <span className="ser__hex">
                  {hex}
                  {more > 0 ? ` …+${more}` : ''}
                </span>
                <span className="ser__ascii">{ascii}</span>
              </div>
            )
          })
        )}
      </div>

      <div className="log__foot">
        <span>{rows.length} frames</span>
        <span>{monitor ? 'MONITORING' : 'OFF'}</span>
      </div>
    </div>
  )
}
