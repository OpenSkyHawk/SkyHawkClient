import { useConfigStore, type SourceMode, type Transport } from '../../config'
import { CaptureCard, RecordCard, RelayStart } from '../../dcs'
import { DeviceCard } from '../../gateway'
import { NodesCard } from '../../nodes'

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

/**
 * The Connection tab: the device card (gateway) and the connected nodes (nodes) on the left; the
 * source mode and DCS link settings (config) between the relay's own controls (dcs) on the right.
 */
export function Connection() {
  const s = useConfigStore()
  const setConfigField = useConfigStore((x) => x.setConfigField)

  return (
    <div className="conn">
      <div className="conn__left">
        <DeviceCard autoConnect={s.autoConnect} />

        <NodesCard autoConnect={s.autoConnect} />
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

        {/* The Capture and Record cards flip together, in the same relay:facts push (R3.4a). */}
        <CaptureCard
          driveSerial={s.replayDriveSerial}
          onToggleDrive={() => setConfigField({ replayDriveSerial: !s.replayDriveSerial })}
        />

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

        <RecordCard />

        <RelayStart />
      </div>
    </div>
  )
}
