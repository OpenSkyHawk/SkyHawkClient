import { useDcsStore } from './store'
import { relayNote, relaySide, startBlockedReason } from './relay-view'

// The Connection tab's relay controls (R3.4b: cut from Connection.tsx). The tab puts its settings
// cards (source mode, DCS link) between them, so each is its own component.

const REC_DOT = (
  <span
    style={{
      display: 'inline-block',
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: 'var(--red)',
      marginRight: 6,
      verticalAlign: 'middle'
    }}
  />
)

/**
 * Load a capture, in Replay. Drive Gateway is a setting: the Connection tab hands in its value and
 * its switch.
 */
export function CaptureCard({
  driveSerial,
  onToggleDrive
}: {
  driveSerial: boolean
  onToggleDrive: () => void
}) {
  const facts = useDcsStore((x) => x.relayFacts)
  const openReplay = useDcsStore((x) => x.openReplay)
  const replay = facts.replay
  if (!facts.captureShown) return null
  return (
    <div className="card field">
      <div className="card-h" style={{ marginBottom: 12 }}>
        Capture
      </div>
      <button className="browse" onClick={() => openReplay()}>
        Load capture…
      </button>
      <div className="hint">
        {replay ? (
          <>
            <span style={{ color: 'var(--text)' }}>{replay.file.split(/[/\\]/).pop()}</span>
            {` · ${replay.events} events · ${(replay.durationMs / 1000).toFixed(1)}s`}
            {' — press Start to play.'}
          </>
        ) : (
          'No capture loaded. Load a recorded session to replay it with no DCS running.'
        )}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 14
        }}
      >
        <div>
          <div className="dev__k">Drive Gateway</div>
          <div style={{ fontSize: 11, color: 'var(--muted-3)', marginTop: 2 }}>
            Also write the replay to the serial device
          </div>
        </div>
        <button
          className={`toggle${driveSerial ? ' on' : ''}`}
          onClick={onToggleDrive}
          aria-pressed={driveSerial}
        >
          <span />
        </button>
      </div>
    </div>
  )
}

/** Record the live stream, outside Replay. */
export function RecordCard() {
  const facts = useDcsStore((x) => x.relayFacts)
  const relaying = useDcsStore((x) => x.relaying)
  const toggleCapture = useDcsStore((x) => x.toggleCapture)
  // The relay controls as main decides them (relay:facts, R3.3), for the on/off as shown.
  const side = relaySide(facts, relaying)
  const recording = facts.recording
  if (!facts.recordShown.connection) return null
  return (
    <div className="card field">
      <div className="card-h" style={{ marginBottom: 12 }}>
        Record
      </div>
      <button
        className="browse"
        onClick={() => toggleCapture()}
        disabled={!side.canRecord.connection}
      >
        {recording.on ? (
          <>
            {REC_DOT}Stop recording · {recording.events ?? 0} events
          </>
        ) : (
          'Start recording…'
        )}
      </button>
      <div className="hint">
        {recording.on
          ? 'Recording live DCS-BIOS stream. Stop to save — replay the file on any machine with no DCS.'
          : side.canRecord.connection
            ? 'Capture a live session to replay later with no DCS running.'
            : 'Start the relay first to enable recording.'}
      </div>
    </div>
  )
}

/** Start / Stop relay, and what a running relay is waiting for or why Start is blocked. */
export function RelayStart() {
  const facts = useDcsStore((x) => x.relayFacts)
  const relaying = useDcsStore((x) => x.relaying)
  const toggleRelay = useDcsStore((x) => x.toggleRelay)
  // The relay controls as main decides them (relay:facts, R3.3), for the on/off as shown.
  const side = relaySide(facts, relaying)
  const blocked = side.startBlocked
  const note = blocked
    ? { text: startBlockedReason(blocked), info: true }
    : relayNote(side.waiting, facts.stream)
  return (
    <div>
      <button
        className={`bigbtn${relaying ? ' bigbtn--stop' : ''}`}
        style={{ width: '100%' }}
        disabled={!!blocked}
        onClick={() => toggleRelay()}
      >
        {relaying ? 'Stop relay' : 'Start relay'}
      </button>
      {note && <div className={`waitnote${note.info ? ' waitnote--info' : ''}`}>{note.text}</div>}
    </div>
  )
}
