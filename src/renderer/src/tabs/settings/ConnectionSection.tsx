import { useStore } from '../../store'
import { relaySide } from '../../device-view'
import { Row, SectionHead } from './Row'

export function ConnectionSection() {
  const s = useStore()
  const setConfigField = useStore((x) => x.setConfigField)
  const toggleCapture = useStore((x) => x.toggleCapture)
  // The recording and whether this row may start one (X12: whenever), as main decides (R3.3).
  const recording = s.relayFacts.recording
  const canRecord = relaySide(s.relayFacts, s.relaying).canRecord.settings

  return (
    <>
      <SectionHead title="Connection" desc="How the client reaches DCS and the Gateway." />
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
        <Row
          k="Connect automatically"
          sub="Open the Gateway on launch and whenever it is plugged in, and recover after a drop. Turn off to leave the port to socat / connect-serial-port.cmd."
        >
          <button
            className={`toggle${s.autoConnect ? ' on' : ''}`}
            onClick={() => setConfigField({ autoConnect: !s.autoConnect })}
            aria-pressed={s.autoConnect}
          >
            <span />
          </button>
        </Row>
        <Row
          k="Record session"
          sub={
            recording.on
              ? `Recording${recording.events != null ? ` · ${recording.events} events` : ''}…`
              : 'Capture the DCS-BIOS stream to a file for replay'
          }
        >
          <button
            className={`browse${recording.on ? ' browse--rec' : ''}`}
            onClick={() => toggleCapture()}
            disabled={!canRecord}
          >
            {recording.on ? '■ Stop' : '● Record'}
          </button>
        </Row>
      </div>
    </>
  )
}
