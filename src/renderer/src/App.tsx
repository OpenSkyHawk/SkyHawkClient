import { useEffect } from 'react'
import { useStore, type TabId } from './store'
import { deviceView, relayTip, relayWaiting } from './device-view'
import { DevicePopover } from './DevicePopover'
import { Overview } from './tabs/Overview'
import { Connection } from './tabs/Connection'
import { Log } from './tabs/Log'
import { Serial } from './tabs/Serial'
import { Hid } from './tabs/Hid'
import { Settings } from './tabs/Settings'

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'connection', label: 'Connection' },
  { id: 'log', label: 'Log' },
  { id: 'serial', label: 'Serial' },
  { id: 'hid', label: 'HID' },
  { id: 'settings', label: 'Settings' }
]

export function App() {
  const tab = useStore((s) => s.tab)
  const sourceMode = useStore((s) => s.sourceMode)
  const relaying = useStore((s) => s.relaying)
  const relayStream = useStore((s) => s.relayStream)
  const deviceState = useStore((s) => s.deviceState)
  const devicePort = useStore((s) => s.devicePort)
  const deviceDetail = useStore((s) => s.deviceDetail)
  const autoConnect = useStore((s) => s.autoConnect)
  const transport = useStore((s) => s.transport)
  const host = useStore((s) => s.host)
  const port = useStore((s) => s.port)
  const replayFile = useStore((s) => s.replayFile)
  const set = useStore((s) => s.set)
  const toggleRelay = useStore((s) => s.toggleRelay)
  const initBridge = useStore((s) => s.initBridge)

  useEffect(() => initBridge(), [initBridge])

  const dev = deviceView(deviceState, { port: devicePort, detail: deviceDetail, autoConnect })
  const endpoint =
    transport === 'tcp'
      ? `${host}:${port}`
      : transport === 'loop'
        ? '239.255.50.10:5010'
        : 'unicast listen'
  // Gold, still "Relaying", while running but not delivering end to end (#69).
  const waiting = relayWaiting({ mode: sourceMode, relaying, stream: relayStream, deviceState })
  const relayTitle = relayTip({
    mode: sourceMode,
    relaying,
    stream: relayStream,
    deviceState,
    deviceLabel: dev.label,
    endpoint,
    replayFile
  })

  return (
    <div className="app">
      <header className="titlebar">
        <span className="wordmark">
          <span className="w-open">OPEN</span>
          <span className="w-sky">SKYHAWK</span>
          <span className="w-client">CLIENT</span>
        </span>
        <div className="titlebar__right">
          <span className="ver">v{__APP_VERSION__}</span>
          {/* The device link: automatic, and independent of the relay pill beside it (#69). */}
          <DevicePopover />
          <button
            className={`pill pill--btn${relaying ? ' pill--on' : ''}${waiting ? ' pill--wait' : ''}`}
            onClick={() => toggleRelay()}
            title={relayTitle}
          >
            <span className="pill__dot" />
            <span className="pill__txt">{relaying ? 'Relaying' : 'Stopped'}</span>
          </button>
        </div>
      </header>

      <nav className="tabbar" role="tablist" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab${tab === t.id ? ' tab--active' : ''}`}
            onClick={() => set({ tab: t.id })}
          >
            {t.label}
          </button>
        ))}
        <span className="tabbar__src">
          SOURCE <b>{sourceMode}</b>
        </span>
      </nav>

      <main className="content scroll" role="tabpanel">
        {tab === 'overview' && <Overview />}
        {tab === 'connection' && <Connection />}
        {tab === 'log' && <Log />}
        {tab === 'serial' && <Serial />}
        {tab === 'hid' && <Hid />}
        {tab === 'settings' && <Settings />}
      </main>
    </div>
  )
}
