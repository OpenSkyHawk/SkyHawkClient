import { useEffect, useState } from 'react'
import type { DeviceStatus } from '@shared/ipc'

const PANELS: { title: string; note: string }[] = [
  { title: 'Connection', note: 'Device + DCS link (M4)' },
  { title: 'Aircraft', note: '_ACFT_NAME @ 0x0000 (M3)' },
  { title: 'Stats', note: 'Health · commands · telemetry (M3)' },
  { title: 'Live Log', note: 'Decoded DCS-BIOS (M3)' },
  { title: 'HID Status', note: 'Axes · buttons · hats (M5)' }
]

export function App(): JSX.Element {
  const [device, setDevice] = useState<DeviceStatus>({ state: 'no-device' })

  useEffect(() => {
    // Wired up once the main process starts pushing status (M3+).
    return window.skyhawk?.on('device:status', setDevice)
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">OPEN&nbsp;SKYHAWK</span>
        <span className="sub">Client</span>
        <span className={`pill pill--${device.state}`}>{device.state}</span>
      </header>

      <main className="grid">
        {PANELS.map((p) => (
          <section className="card" key={p.title}>
            <h2>{p.title}</h2>
            <p className="muted">{p.note}</p>
          </section>
        ))}
      </main>

      <footer className="statusbar muted">
        Scaffold · v0.0.0 · waiting for SimGateway / DCS-BIOS source
      </footer>
    </div>
  )
}
