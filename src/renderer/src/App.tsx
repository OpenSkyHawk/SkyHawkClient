import { useStore, type TabId } from './store'
import { Overview } from './tabs/Overview'
import { Connection } from './tabs/Connection'
import { Log } from './tabs/Log'
import { Hid } from './tabs/Hid'
import { Settings } from './tabs/Settings'

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'connection', label: 'Connection' },
  { id: 'log', label: 'Log' },
  { id: 'hid', label: 'HID' },
  { id: 'settings', label: 'Settings' }
]

export function App() {
  const tab = useStore((s) => s.tab)
  const sourceMode = useStore((s) => s.sourceMode)
  const relaying = useStore((s) => s.relaying)
  const set = useStore((s) => s.set)

  return (
    <div className="app">
      <header className="titlebar">
        <span className="wordmark">
          <span className="w-open">OPEN</span>
          <span className="w-sky">SKYHAWK</span>
          <span className="w-client">CLIENT</span>
        </span>
        <div className="titlebar__right">
          <span className="ver">v0.1.0</span>
          <span className={`pill${relaying ? ' pill--on' : ''}`}>
            <span className="pill__dot" />
            <span className="pill__txt">{relaying ? 'Relaying' : 'Stopped'}</span>
          </span>
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
        {tab === 'hid' && <Hid />}
        {tab === 'settings' && <Settings />}
      </main>
    </div>
  )
}
