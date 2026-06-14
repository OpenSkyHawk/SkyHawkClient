import { useStore } from '../store'

const pad = (n: number) => String(n).padStart(2, '0')
const pad3 = (n: number) => String(n).padStart(3, '0')
function fmtTime(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad3(d.getMilliseconds())}`
}

const MAX_BYTES = 48 // truncate very long chunks in the display

function render(hex: string): { hex: string; ascii: string; more: number } {
  const bytes = Math.floor(hex.length / 2)
  const shown = Math.min(bytes, MAX_BYTES)
  let h = ''
  let a = ''
  for (let i = 0; i < shown; i++) {
    const pair = hex.slice(i * 2, i * 2 + 2)
    const b = parseInt(pair, 16)
    h += (i ? ' ' : '') + pair.toUpperCase()
    a += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '·'
  }
  return { hex: h, ascii: a, more: bytes - shown }
}

export function Serial() {
  const monitor = useStore((x) => x.serialMonitor)
  const rows = useStore((x) => x.serialLog)
  const setSerialMonitor = useStore((x) => x.setSerialMonitor)
  const clearSerial = useStore((x) => x.clearSerial)
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
              ? 'Monitoring — no serial traffic yet. (TX/RX needs Bridge mode + a connected SimGateway.)'
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
