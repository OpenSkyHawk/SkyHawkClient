import type { ReactNode } from 'react'
import { useStore } from '../store'

function Row({ k, sub, children }: { k: string; sub: string; children: ReactNode }) {
  return (
    <div className="set-row">
      <div>
        <div className="set-row__label">{k}</div>
        <div className="set-row__desc">{sub}</div>
      </div>
      <div>{children}</div>
    </div>
  )
}

export function Settings() {
  const s = useStore()
  const setConfigField = useStore((x) => x.setConfigField)

  return (
    <div className="settings">
      <div className="set-card">
        <Row k="Source mode" sub="How telemetry reaches the client">
          <span className="set-row__value" style={{ textTransform: 'capitalize' }}>
            {s.sourceMode}
          </span>
        </Row>
        <Row k="DCS host" sub="Target for the bidirectional TCP link">
          <input
            className="input"
            style={{ width: 160 }}
            value={s.host}
            onChange={(e) => setConfigField({ host: e.target.value })}
          />
        </Row>
        <Row k="Command port" sub="DCS-BIOS import / command sink">
          <input
            className="input"
            style={{ width: 100 }}
            value={s.port}
            onChange={(e) => setConfigField({ port: e.target.value })}
          />
        </Row>
        <Row k="Auto-reconnect" sub="Re-open the serial port on unplug">
          <button
            className={`toggle${s.autoReconnect ? ' on' : ''}`}
            onClick={() => setConfigField({ autoReconnect: !s.autoReconnect })}
            aria-pressed={s.autoReconnect}
          >
            <span />
          </button>
        </Row>
        <Row k="Capture file" sub="Record / replay DCS-BIOS sessions">
          <button className="browse">Choose…</button>
        </Row>
      </div>

      <div className="set-foot">OpenSkyhawk Client · com.openskyhawk.client · GPL-2.0-only</div>
    </div>
  )
}
