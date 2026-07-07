import { fmtUptime, useStore, type SourceMode, type Transport } from '../store'
import { nodeDotState, nodeFaultTag, nodeFaultTooltip } from '@shared/nodes'

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

function NodesCard() {
  const nodes = useStore((x) => x.nodes)
  const sourceMode = useStore((x) => x.sourceMode)
  const refreshNodes = useStore((x) => x.refreshNodes)
  const isBridge = sourceMode === 'bridge'

  return (
    <div className="card field">
      <div className="panel-h">
        <span className="section-h">Connected nodes</span>
        <button className="toolbtn" onClick={() => refreshNodes()} disabled={!isBridge}>
          Refresh
        </button>
      </div>
      {!isBridge ? (
        <div className="hint">
          PanelGroup node status is reported over the serial link — Bridge mode only.
        </div>
      ) : nodes.length === 0 ? (
        <div className="hint">No nodes reported. Power on a PanelGroup, or press Refresh.</div>
      ) : (
        <div className="nodes">
          {nodes.map((n) => (
            <div className={`node${n.present ? '' : ' node--off'}`} key={n.nodeId}>
              <span className={`node__dot ${nodeDotState(n)}`} />
              <span className="node__id">{n.name ?? `Node ${n.nodeId}`}</span>
              <span className="node__meta">
                #{n.nodeId} · up {fmtUptime(n.uptimeSec)} · rx {n.rxCount}
                {n.dieTempC != null && (
                  <>
                    {' · '}
                    <span className={n.overheat ? 'node__temp node__temp--hot' : 'node__temp'}>
                      {n.overheat && '🔥 '}~{n.dieTempC}°C
                    </span>
                  </>
                )}
              </span>
              <span className="node__flags">
                {!n.present && <b className="flag flag--err">OFFLINE</b>}
                {n.boff && <b className="flag flag--err">BOFF</b>}
                {n.degraded && (
                  <b className="flag flag--warn" title={nodeFaultTooltip(n)}>
                    {nodeFaultTag(n)}
                  </b>
                )}
                {n.epvf && <b className="flag flag--warn">EPVF</b>}
                {(n.tec > 0 || n.rec > 0) && (
                  <span className="node__err">
                    TEC {n.tec} / REC {n.rec}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const HINTS: Record<SourceMode, string> = {
  bridge:
    'Full relay — SimGateway serial ↔ DCS-BIOS, plus HID. Replaces socat / connect-serial-port.cmd.',
  monitor:
    'No device — read DCS-BIOS off the LAN to inspect/test the stream. Serial relay + HID inactive.',
  replay:
    'No DCS — feed the parser/UI from a recorded capture; optionally drive the SimGateway serial.'
}

const TRANSPORTS: { id: Transport; title: string; detail: string }[] = [
  { id: 'tcp', title: 'TCP to host', detail: '<ip>:7778 · remote' },
  { id: 'loop', title: 'Loopback multicast', detail: '239.255.50.10:5010 · local' },
  { id: 'uni', title: 'Unicast listen', detail: 'BIOSConfig.lua send_address' }
]

export function Connection() {
  const s = useStore()
  const setConfigField = useStore((x) => x.setConfigField)
  const toggleRelay = useStore((x) => x.toggleRelay)
  const openReplay = useStore((x) => x.openReplay)
  const toggleCapture = useStore((x) => x.toggleCapture)

  // The device details are live: populated once a SimGateway is actually found.
  // Before that, only the match target (VID/PID) is shown — not real device data.
  const connected = !!s.devicePort
  const deviceRows = [
    { k: 'Identity', v: connected ? 'A-4E Skyhawk' : '— no device' },
    { k: 'VID / PID', v: connected ? '0x2E8A / 0x4134' : '0x2E8A / 0x4134 · target' },
    {
      k: 'Serial port',
      v: s.devicePort ?? (s.sourceMode === 'bridge' ? 'scanning…' : 'monitor — no device')
    },
    { k: 'Interfaces', v: connected ? 'CDC serial + HID' : '—' }
  ]

  return (
    <div className="conn">
      <div className="conn__left">
        {/* device card */}
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="dev__head">
            <div className="dev__icon">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#1e8fff"
                strokeWidth="1.6"
              >
                <rect x="4" y="7" width="16" height="11" rx="2" />
                <path d="M9 7V5h6v2M9 18v2M15 18v2" />
              </svg>
            </div>
            <div style={{ flex: 1 }}>
              <div className="dev__name">A-4E Skyhawk · SimGateway</div>
              <div className="dev__meta">composite USB · CDC + HID</div>
            </div>
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                fontFamily: 'var(--disp)',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: s.relaying ? 'var(--green)' : 'var(--muted)'
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: s.relaying ? 'var(--green)' : 'var(--muted-3)',
                  boxShadow: s.relaying ? '0 0 8px var(--green)' : 'none'
                }}
              />
              {s.relaying ? 'Relaying' : 'Stopped'}
            </span>
          </div>
          <div className="dev__body">
            {deviceRows.map((d) => (
              <div className="dev__row" key={d.k}>
                <span className="dev__k">{d.k}</span>
                <span className="dev__v">{d.v}</span>
              </div>
            ))}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingTop: 14
              }}
            >
              <div>
                <div className="dev__k">Auto-reconnect</div>
                <div style={{ fontSize: 11, color: 'var(--muted-3)', marginTop: 2 }}>
                  Re-open the port on unplug
                </div>
              </div>
              <button
                className={`toggle${s.autoReconnect ? ' on' : ''}`}
                onClick={() => setConfigField({ autoReconnect: !s.autoReconnect })}
                aria-pressed={s.autoReconnect}
              >
                <span />
              </button>
            </div>
          </div>
        </div>

        <NodesCard />
      </div>

      {/* controls */}
      <div className="controls">
        <div className="card field">
          <div className="card-h" style={{ marginBottom: 12 }}>
            Source Mode
          </div>
          <div className="seg">
            {(['bridge', 'monitor', 'replay'] as SourceMode[]).map((m) => (
              <button
                key={m}
                className={s.sourceMode === m ? 'on' : ''}
                onClick={() => setConfigField({ sourceMode: m })}
              >
                {m[0]!.toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
          <div className="hint">{HINTS[s.sourceMode]}</div>
        </div>

        {s.sourceMode === 'replay' && (
          <div className="card field">
            <div className="card-h" style={{ marginBottom: 12 }}>
              Capture
            </div>
            <button className="browse" onClick={() => openReplay()}>
              Load capture…
            </button>
            <div className="hint">
              {s.replayFile ? (
                <>
                  <span style={{ color: 'var(--text)' }}>{s.replayFile.split(/[/\\]/).pop()}</span>
                  {s.replayInfo
                    ? ` · ${s.replayInfo.events} events · ${(s.replayInfo.durationMs / 1000).toFixed(1)}s`
                    : ''}
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
                <div className="dev__k">Drive SimGateway</div>
                <div style={{ fontSize: 11, color: 'var(--muted-3)', marginTop: 2 }}>
                  Also write the replay to the serial device
                </div>
              </div>
              <button
                className={`toggle${s.replayDriveSerial ? ' on' : ''}`}
                onClick={() => setConfigField({ replayDriveSerial: !s.replayDriveSerial })}
                aria-pressed={s.replayDriveSerial}
              >
                <span />
              </button>
            </div>
          </div>
        )}

        <div className="card field">
          <div className="card-h" style={{ marginBottom: 12 }}>
            DCS Link
          </div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <div className="input-label">DCS host</div>
              <input
                className="input"
                value={s.host}
                onChange={(e) => setConfigField({ host: e.target.value })}
              />
            </div>
            <div style={{ width: 92 }}>
              <div className="input-label">Port</div>
              <input
                className="input"
                value={s.port}
                onChange={(e) => setConfigField({ port: e.target.value })}
              />
            </div>
          </div>
          <div className="input-label">Transport</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {TRANSPORTS.map((t) => (
              <button
                key={t.id}
                className={`radio${s.transport === t.id ? ' on' : ''}`}
                onClick={() => setConfigField({ transport: t.id })}
              >
                <span className="radio__dot">
                  <span />
                </span>
                <span style={{ flex: 1 }}>
                  <span className="radio__t">{t.title}</span>{' '}
                  <span className="radio__d">{t.detail}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        {s.sourceMode !== 'replay' && (
          <div className="card field">
            <div className="card-h" style={{ marginBottom: 12 }}>
              Record
            </div>
            <button className="browse" onClick={() => toggleCapture()} disabled={!s.relaying}>
              {s.recording ? (
                <>
                  {REC_DOT}Stop recording · {s.recordEvents ?? 0} events
                </>
              ) : (
                'Start recording…'
              )}
            </button>
            <div className="hint">
              {s.recording
                ? 'Recording live DCS-BIOS stream. Stop to save — replay the file on any machine with no DCS.'
                : s.relaying
                  ? 'Capture a live session to replay later with no DCS running.'
                  : 'Start the relay first to enable recording.'}
            </div>
          </div>
        )}

        <button
          className={`bigbtn${s.relaying ? ' bigbtn--stop' : ''}`}
          onClick={() => toggleRelay()}
        >
          {s.relaying ? 'Stop relay' : 'Start relay'}
        </button>
      </div>
    </div>
  )
}
