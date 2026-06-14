import { create } from 'zustand'
import type {
  AircraftStatus,
  AppConfig,
  DcsTransport,
  DeviceState,
  LogRow as IpcLogRow,
  TelemetryReadout
} from '@shared/ipc'

export type TabId = 'overview' | 'connection' | 'log' | 'hid' | 'settings'
export type SourceMode = 'bridge' | 'monitor' | 'replay'
export type Transport = 'tcp' | 'loop' | 'uni'
export type DirFilter = 'all' | 'in' | 'out'

export interface LogRow {
  id: number
  time: string
  dir: 'in' | 'out'
  name: string
  addrHex: string
  value: number | string
  raw: string
}

export const AXIS_LABELS = [
  'Roll',
  'Pitch',
  'Throttle',
  'Rudder',
  'Brake L',
  'Brake R',
  'Zoom',
  'Spare'
]

// ── renderer <-> main transport mapping ──────────────────────────────────────
const TRANSPORT_TO_IPC: Record<Transport, DcsTransport> = {
  tcp: 'tcp-to-host',
  loop: 'loopback-multicast',
  uni: 'unicast-listen'
}

// Representative A-4E-C controls for the placeholder log (name, value, dir, address).
const POOL: [string, number, 'in' | 'out', number][] = [
  ['RPM', 84, 'in', 0x8420],
  ['D_IAS_DEG', 142, 'in', 0x8410],
  ['D_ALT_NEEDLE', 14210, 'in', 0x8440],
  ['D_FUEL', 3120, 'in', 0x8450],
  ['D_FLAPS_IND', 50, 'in', 0x8460],
  ['MASTER_ARM', 1, 'out', 0x8512],
  ['GEAR_LEVER', 0, 'out', 0x8516]
]

const pad = (n: number) => String(n).padStart(2, '0')
const pad3 = (n: number) => String(n).padStart(3, '0')
const hex2 = (n: number) => (n & 0xff).toString(16).toUpperCase().padStart(2, '0')
const hex4 = (n: number) => '0x' + (n & 0xffff).toString(16).toUpperCase().padStart(4, '0')

function fmtTime(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad3(d.getMilliseconds())}`
}

function rawHex(addr: number, value: number | string): string {
  const v = typeof value === 'number' ? Math.abs(value) & 0xffff : 0
  return `${hex2(addr >> 8)} ${hex2(addr)} ${hex2(v)} ${hex2(v >> 8)}`
}

function seedLog(): LogRow[] {
  const now = Date.now()
  return Array.from({ length: 18 }, (_, i) => {
    const [name, value, dir, addr] = POOL[i % POOL.length]!
    return {
      id: i,
      time: fmtTime(now - i * 280),
      dir,
      name,
      value,
      addrHex: hex4(addr),
      raw: rawHex(addr, value)
    }
  })
}

const SEED_TELEMETRY: TelemetryReadout[] = [
  { id: 'RPM', label: 'RPM', value: 84, pct: 0.84, unit: '% RPM' },
  { id: 'D_IAS_DEG', label: 'IAS', value: 142, pct: 0.32, unit: 'KNOTS' },
  { id: 'D_FLAPS_IND', label: 'Flap', value: 50, pct: 0.5, unit: '% DN' },
  { id: 'D_ALT_NEEDLE', label: 'Press Alt', value: 14210, pct: 0.36, unit: 'FEET' },
  { id: 'D_FUEL', label: 'Fuel', value: 62, pct: 0.62, unit: '% QTY' }
]

const MAX_LOG = 500

export interface AppState {
  // UI state
  tab: TabId
  sourceMode: SourceMode
  transport: Transport
  host: string
  port: string
  autoReconnect: boolean
  relaying: boolean
  logPaused: boolean
  autoscroll: boolean
  rawMode: boolean
  dirFilter: DirFilter
  search: string

  // live link state
  deviceState: DeviceState
  aircraft: AircraftStatus

  // telemetry + stats (live once relaying; seeded placeholders before)
  telemetry: TelemetryReadout[]
  bytesIn: number
  bytesOut: number
  fps: number
  errors: number
  uptime: number
  reconnects: number
  cmdsPerSec: number
  cmdsTotal: number
  lastCmd: string

  // HID placeholders (wired in M5)
  axes: number[]
  buttons: number[]
  hats: number[]
  hidRate: number

  log: LogRow[]
  private_logSeq: number

  set: (patch: Partial<AppState>) => void
  toggle: (key: 'logPaused' | 'autoscroll' | 'rawMode') => void
  setConfigField: (
    patch: Partial<Pick<AppState, 'sourceMode' | 'transport' | 'host' | 'port' | 'autoReconnect'>>
  ) => void
  toggleRelay: () => void
  initBridge: () => void
}

function buildConfig(s: AppState): Partial<AppConfig> {
  return {
    sourceMode: s.sourceMode,
    transport: TRANSPORT_TO_IPC[s.transport],
    host: s.host,
    commandPort: Number(s.port) || 7778,
    autoReconnect: s.autoReconnect
  }
}

export const useStore = create<AppState>((set, get) => ({
  tab: 'overview',
  sourceMode: 'monitor',
  transport: 'tcp',
  host: '127.0.0.1',
  port: '7778',
  autoReconnect: true,
  relaying: false,
  logPaused: false,
  autoscroll: true,
  rawMode: false,
  dirFilter: 'all',
  search: '',

  deviceState: 'no-device',
  aircraft: { name: 'NONE', inferred: false, supported: true },

  telemetry: SEED_TELEMETRY,
  bytesIn: 0,
  bytesOut: 0,
  fps: 0,
  errors: 0,
  uptime: 0,
  reconnects: 0,
  cmdsPerSec: 0,
  cmdsTotal: 0,
  lastCmd: '—',

  axes: [4200, -1800, 22600, 0, 0, 0, -8000, 0],
  buttons: [0, 3, 12, 45, 88, 102],
  hats: [0, 8, 0, 3],
  hidRate: 0,

  log: seedLog(),
  private_logSeq: 1000,

  set: (patch) => set(patch),
  toggle: (key) => set((s) => ({ [key]: !s[key] }) as Partial<AppState>),

  setConfigField: (patch) => {
    set(patch as Partial<AppState>)
    void window.skyhawk?.setConfig(buildConfig(get()))
  },

  toggleRelay: () => {
    const s = get()
    if (s.relaying) {
      void window.skyhawk?.stopRelay()
      set({ relaying: false })
    } else {
      void window.skyhawk?.setConfig(buildConfig(s)).then(() => window.skyhawk?.startRelay())
      set({ relaying: true })
    }
  },

  initBridge: () => {
    const api = window.skyhawk
    if (!api) return // running outside Electron (tests / web preview)

    void api.getConfig().then((cfg) => {
      const transport = (Object.keys(TRANSPORT_TO_IPC) as Transport[]).find(
        (k) => TRANSPORT_TO_IPC[k] === cfg.transport
      )
      set({
        sourceMode: cfg.sourceMode,
        transport: transport ?? 'tcp',
        host: cfg.host,
        port: String(cfg.commandPort),
        autoReconnect: cfg.autoReconnect
      })
    })

    api.on('device:status', (d) => set({ deviceState: d.state }))
    api.on('aircraft:changed', (a) => set({ aircraft: a }))
    api.on('telemetry:tick', (t) => set({ telemetry: t }))
    api.on('stats:tick', (st) =>
      set({
        bytesIn: st.bytesInPerSec,
        bytesOut: st.bytesOutPerSec,
        fps: st.framesPerSec,
        errors: st.errors,
        uptime: st.uptimeSec,
        reconnects: st.reconnects,
        cmdsPerSec: st.commandsPerSec,
        cmdsTotal: st.commandsTotal,
        lastCmd: st.lastCommand ?? '—'
      })
    )
    api.on('log:batch', (rows) => {
      const s = get()
      if (s.logPaused) return
      let seq = s.private_logSeq
      const mapped: LogRow[] = rows.map((r: IpcLogRow) => ({
        id: seq++,
        time: fmtTime(r.t),
        dir: r.dir,
        name: r.name ?? hex4(r.address),
        addrHex: hex4(r.address),
        value: r.value,
        raw: r.raw ?? rawHex(r.address, r.value)
      }))
      // newest first, capped
      set({ log: [...mapped.reverse(), ...s.log].slice(0, MAX_LOG), private_logSeq: seq })
    })
  }
}))

// ── pure helpers ─────────────────────────────────────────────────────────────
export function fmtBytes(n: number): string {
  return n >= 1024 ? (n / 1024).toFixed(1) + ' KB/s' : Math.round(n) + ' B/s'
}

export function fmtUptime(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${pad(h)}:${pad(m)}:${pad(sec)}`
}

export const HAT_DIRS = ['CTR', 'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
