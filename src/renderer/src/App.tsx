import { useEffect, useState } from 'react'
import type { DeviceStatus } from '@shared/ipc'
import logo from './assets/logo.png'
import { Overview, Connection, LogView, Hid, Settings } from './tabs'

type TabId = 'overview' | 'connection' | 'log' | 'hid' | 'settings'

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'connection', label: 'Connection' },
  { id: 'log', label: 'Log' },
  { id: 'hid', label: 'HID' },
  { id: 'settings', label: 'Settings' }
]

export function App() {
  const [tab, setTab] = useState<TabId>('overview')
  const [device, setDevice] = useState<DeviceStatus>({ state: 'no-device' })

  useEffect(() => window.skyhawk?.on('device:status', setDevice), [])

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">OPEN&nbsp;SKYHAWK</span>
        <span className="brand-sub">Client</span>
        <span className={`pill pill--${device.state}`}>{device.state.replace(/-/g, ' ')}</span>
      </header>

      <nav className="tabs" role="tablist" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab${tab === t.id ? ' tab--active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="content" role="tabpanel">
        {tab === 'overview' && <Overview logo={logo} device={device} />}
        {tab === 'connection' && <Connection />}
        {tab === 'log' && <LogView />}
        {tab === 'hid' && <Hid />}
        {tab === 'settings' && <Settings />}
      </main>
    </div>
  )
}
