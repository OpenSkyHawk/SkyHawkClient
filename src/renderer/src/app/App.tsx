import { useEffect } from 'react'
import { useDcsStore } from '../dcs'
import { SerialTab } from '../gateway'
import { initBridge } from './ipc-adapter'
import { useNav, type TabId } from './kit'
import { DevicePopover } from './titlebar/DevicePopover'
import { RelayPill } from './titlebar/RelayPill'
import { Overview } from './overview/Overview'
import { Connection } from './connection/Connection'
import { Cockpit } from './cockpit/Cockpit'
import { Log } from './log/Log'
import { HidTab } from './hid/HidTab'
import { Settings } from './settings/Settings'

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'connection', label: 'Connection' },
  { id: 'cockpit', label: 'Cockpit' },
  { id: 'log', label: 'Log' },
  { id: 'serial', label: 'Serial' },
  { id: 'hid', label: 'HID' },
  { id: 'settings', label: 'Settings' }
]

export function App() {
  const tab = useNav((s) => s.tab)
  // The mode the relay's facts were judged against (R3.4c), as the Connection tab's segment shows it.
  const sourceMode = useDcsStore((s) => s.relayFacts.mode)
  const set = useNav((s) => s.set)

  useEffect(() => initBridge(), [])

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
          <RelayPill />
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
        {tab === 'cockpit' && <Cockpit />}
        {tab === 'log' && <Log />}
        {tab === 'serial' && <SerialTab />}
        {tab === 'hid' && <HidTab />}
        {tab === 'settings' && <Settings />}
      </main>
    </div>
  )
}
