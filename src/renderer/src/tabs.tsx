import type { DeviceStatus } from '@shared/ipc'

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="tile">
      <span className="tile__label">{label}</span>
      <span className="tile__value">{value}</span>
    </div>
  )
}

function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div className="placeholder">
      <h2>{title}</h2>
      <p className="muted">{note}</p>
    </div>
  )
}

export function Overview({ logo, device }: { logo: string; device: DeviceStatus }) {
  return (
    <div className="overview">
      <img className="overview__logo" src={logo} alt="OpenSkyhawk" />
      <p className="overview__tagline">SimGateway connector &amp; DCS-BIOS / HID monitor</p>
      <div className="overview__tiles">
        <StatTile label="Device" value={device.state.replace(/-/g, ' ')} />
        <StatTile label="Aircraft" value="—" />
        <StatTile label="DCS link" value="—" />
      </div>
      <p className="muted overview__hint">
        Connect a SimGateway, or point at a DCS-BIOS source in Settings, to begin.
      </p>
    </div>
  )
}

export function Connection() {
  return (
    <Placeholder title="Connection" note="Device detection + DCS link controls (Milestone 4)." />
  )
}

export function LogView() {
  return (
    <Placeholder
      title="Live Log"
      note="Decoded DCS-BIOS stream, filter / pause / export (Milestone 3)."
    />
  )
}

export function Hid() {
  return <Placeholder title="HID Status" note="Axes · buttons · hats, live (Milestone 5)." />
}

export function Settings() {
  return (
    <Placeholder title="Settings" note="Source mode, DCS host, transport, ports (Milestone 3+)." />
  )
}
