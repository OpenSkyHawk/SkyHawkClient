import { useStore } from '../../store'
import { Row, SectionHead } from './Row'

export function DiagnosticsSection() {
  const s = useStore()
  const setConfigField = useStore((x) => x.setConfigField)
  const dumpSerialPorts = useStore((x) => x.dumpSerialPorts)
  const revealDebugLog = useStore((x) => x.revealDebugLog)

  return (
    <>
      <SectionHead
        title="Diagnostics"
        desc="Logs for troubleshooting connection and device problems."
      />
      <div className="set-card">
        <Row k="Debug logging" sub="Write serial enumeration + device events to a local log file">
          <button
            className={`toggle${s.debugMode ? ' on' : ''}`}
            onClick={() => setConfigField({ debugMode: !s.debugMode })}
            aria-pressed={s.debugMode}
          >
            <span />
          </button>
        </Row>
        <Row
          k="Dump serial ports"
          sub={
            s.debugDump
              ? `Wrote ${s.debugDump.count} port(s) → ${s.debugDump.path}`
              : 'Write every detected serial port (all USB fields) to the log'
          }
        >
          <button className="browse" onClick={() => dumpSerialPorts()}>
            Dump
          </button>
        </Row>
        <Row k="Debug log file" sub="Reveal the log in your file manager">
          <button className="browse" onClick={() => revealDebugLog()}>
            Reveal
          </button>
        </Row>
      </div>
    </>
  )
}
