import { useMemo } from 'react'
import { useStore, type SourceMode, type Transport } from '../store'
import { USB_IDENTITY } from '@shared/firmware'
import { isLinkUp } from '@shared/ipc'
import { nodeViews } from '../cockpit'
import { nodesSummary } from '../connection-summary'
import { deviceView, relayNote, startBlocked, startBlockedReason } from '../device-view'
import { Dot } from './cockpit/Dot'

/** `0x2E8A`: a USB id as the device card prints it, four upper-case hex digits. */
const usbId = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(4, '0')
const VID_PID = `${usbId(USB_IDENTITY.vid)} / ${usbId(USB_IDENTITY.pid)}`

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
 * Connected nodes (#66): counts and the nodes that need attention, most severe first — the same
 * order as Cockpit › Attention. Healthy nodes are left to the Cockpit tab.
 */
function NodesCard() {
  const model = useStore((x) => x.nodeModel)
  const telemetry = useStore((x) => x.nodeTelemetry)
  const deviceState = useStore((x) => x.deviceState)
  const autoConnect = useStore((x) => x.autoConnect)
  const refreshNodes = useStore((x) => x.refreshNodes)
  const openInCockpit = useStore((x) => x.openInCockpit)
  const set = useStore((x) => x.set)
  // Node status rides on the device link, which is up in every source mode (#69).
  const linkUp = isLinkUp(deviceState)
  const sum = useMemo(
    () => nodesSummary(model ? nodeViews(model, telemetry) : [], model?.outages ?? []),
    [model, telemetry]
  )

  return (
    <div className="card field ncard">
      <div className="panel-h">
        <span className="section-h">Connected nodes</span>
        <button className="toolbtn" onClick={() => refreshNodes()} disabled={!linkUp}>
          Refresh
        </button>
      </div>
      {!linkUp ? (
        <div className="hint">{deviceView(deviceState, { autoConnect }).nodesHint}</div>
      ) : sum.known === 0 ? (
        <div className="hint">No nodes reported. Power on a PanelGroup, or press Refresh.</div>
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

const HINTS: Record<SourceMode, string> = {
  bridge:
    'Full relay — Gateway serial ↔ DCS-BIOS, plus HID. Replaces socat / connect-serial-port.cmd.',
  monitor:
    'Read DCS-BIOS off the LAN to inspect/test the stream — nothing is sent to the device. The device link, HID and node status stay up.',
  replay:
    'No DCS — feed the parser/UI from a recorded capture; optionally drive the Gateway over the same link.'
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
  const connectDevice = useStore((x) => x.connectDevice)
  const set = useStore((x) => x.set)
  const disconnectDevice = useStore((x) => x.disconnectDevice)

  // The device card shows the link (#69), which is automatic and independent of the relay.
  // Before a SimGateway is found, only the match target (VID/PID) is shown — not real device data.
  const connected = isLinkUp(s.deviceState)
  const dev = deviceView(s.deviceState, {
    port: s.devicePort,
    detail: s.deviceDetail,
    autoConnect: s.autoConnect
  })
  const blocked =
    !s.relaying &&
    startBlocked({
      mode: s.sourceMode,
      replayDriveSerial: s.replayDriveSerial,
      deviceState: s.deviceState
    })
  const note = blocked
    ? { text: startBlockedReason(s.sourceMode), info: true }
    : relayNote({
        mode: s.sourceMode,
        relaying: s.relaying,
        stream: s.relayStream,
        deviceState: s.deviceState
      })
  const deviceRows = [
    { k: 'Identity', v: connected ? USB_IDENTITY.product : '— no device' },
    { k: 'VID / PID', v: connected ? VID_PID : `${VID_PID} · target` },
    { k: 'Serial port', v: dev.portRow },
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
              <div className="dev__name">{`${USB_IDENTITY.product} · Gateway`}</div>
              <div className="dev__meta">composite USB · CDC + HID</div>
            </div>
            <span className={`devind ${dev.cls}`} title={dev.tip}>
              <span className="devind__dot" />
              {dev.chip}
            </span>
            <button
              className={dev.button.action === 'disconnect' ? 'toolbtn' : 'browse'}
              style={{ padding: '7px 14px' }}
              disabled={dev.button.disabled}
              onClick={() =>
                dev.button.action === 'disconnect' ? disconnectDevice() : connectDevice()
              }
            >
              {dev.button.label}
            </button>
          </div>
          <div className="dev__body">
            {deviceRows.map((d) => (
              <div className="dev__row" key={d.k}>
                <span className="dev__k">{d.k}</span>
                <span className="dev__v">{d.v}</span>
              </div>
            ))}
            {dev.note && (
              <div className="devnote">
                {dev.note}
                {dev.noteSettingsLink && (
                  <>
                    {' '}
                    <button className="devnote__link" onClick={() => set({ tab: 'settings' })}>
                      Settings › Connection
                    </button>
                  </>
                )}
              </div>
            )}
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
                <div className="dev__k">Drive Gateway</div>
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

        <div>
          <button
            className={`bigbtn${s.relaying ? ' bigbtn--stop' : ''}`}
            style={{ width: '100%' }}
            disabled={blocked}
            onClick={() => toggleRelay()}
          >
            {s.relaying ? 'Stop relay' : 'Start relay'}
          </button>
          {note && (
            <div className={`waitnote${note.info ? ' waitnote--info' : ''}`}>{note.text}</div>
          )}
        </div>
      </div>
    </div>
  )
}
