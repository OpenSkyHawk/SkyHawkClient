import { useConfigStore } from '../../config'
import { relaySide, useDcsStore } from '../../dcs'
import { Row, SectionHead } from '../kit'

export function ConnectionSection() {
  const s = useConfigStore()
  const dcs = useDcsStore()
  const setConfigField = useConfigStore((x) => x.setConfigField)
  const typeLinkField = useConfigStore((x) => x.typeLinkField)
  const commitLinkField = useConfigStore((x) => x.commitLinkField)
  const toggleCapture = useDcsStore((x) => x.toggleCapture)
  // The recording and whether this row may start one (X12: only while relaying, as the Connection
  // tab's card), as main decides (R3.3), and whether the row shows (always; R3.4a).
  const recording = dcs.relayFacts.recording
  const canRecord = relaySide(dcs.relayFacts, dcs.relaying).canRecord
  const recordShown = dcs.relayFacts.recordShown.settings

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
            onChange={(e) => typeLinkField('host', e.target.value)}
            onBlur={() => commitLinkField('host')}
            onKeyDown={(e) => e.key === 'Enter' && commitLinkField('host')}
          />
        </Row>
        <Row k="Command port" sub="DCS-BIOS import / command sink">
          <input
            className={`input${s.portError ? ' input--bad' : ''}`}
            style={{ width: 100 }}
            aria-invalid={!!s.portError}
            value={s.port}
            onChange={(e) => typeLinkField('port', e.target.value)}
            onBlur={() => commitLinkField('port')}
            onKeyDown={(e) => e.key === 'Enter' && commitLinkField('port')}
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
        {recordShown && (
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
        )}
      </div>
      {s.portError && (
        <div className="set-err" style={{ margin: '10px 2px 0' }}>
          {s.portError}
        </div>
      )}
    </>
  )
}
