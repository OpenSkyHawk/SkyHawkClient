import { create } from 'zustand'

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
  value: number
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

// Representative A-4E-C controls for the placeholder log (name, value, dir, address).
const POOL: [string, number, 'in' | 'out', number][] = [
  ['RPM', 84, 'in', 0x8420],
  ['IAS', 142, 'in', 0x8410],
  ['ALT_PRESSURE', 14210, 'in', 0x8440],
  ['FUEL_QTY', 3120, 'in', 0x8450],
  ['EGT', 540, 'in', 0x8460],
  ['OIL_PRESSURE', 45, 'in', 0x8462],
  ['COMPASS_HDG', 271, 'in', 0x8480],
  ['ADI_BANK', 124, 'in', 0x8482],
  ['MASTER_ARM', 1, 'out', 0x8512],
  ['FLAPS_LEVER', 2, 'out', 0x8514],
  ['GEAR_LEVER', 0, 'out', 0x8516],
  ['SPEEDBRAKE_SW', 0, 'out', 0x8518],
  ['HOOK_LEVER', 0, 'out', 0x851a],
  ['TACAN_CHAN_SEL', 64, 'out', 0x8520],
  ['LANDING_LIGHT', 0, 'out', 0x8526],
  ['ENGINE_START', 1, 'out', 0x852a]
]

const pad = (n: number) => String(n).padStart(2, '0')
const pad3 = (n: number) => String(n).padStart(3, '0')
const hex2 = (n: number) => (n & 0xff).toString(16).toUpperCase().padStart(2, '0')

function seedLog(): LogRow[] {
  const now = Date.now()
  const rows: LogRow[] = []
  for (let i = 0; i < 26; i++) {
    const [name, value, dir, addr] = POOL[i % POOL.length]!
    const d = new Date(now - i * 280)
    const v = Math.abs(value) & 0xffff
    rows.push({
      id: i,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad3(d.getMilliseconds())}`,
      dir,
      name,
      value,
      addrHex: '0x' + addr.toString(16).toUpperCase().padStart(4, '0'),
      raw: `${hex2(addr >> 8)} ${hex2(addr)} ${hex2(v)} ${hex2(v >> 8)}`
    })
  }
  return rows
}

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

  // Placeholder telemetry / data — replaced by IPC streams in M3+.
  rpm: number
  ias: number
  flap: number
  alt: number
  fuel: number
  bytesIn: number
  bytesOut: number
  fps: number
  errors: number
  uptime: number
  reconnects: number
  cmdsPerSec: number
  cmdsTotal: number
  lastCmd: string
  axes: number[]
  buttons: number[] // lit button indices
  hats: number[]
  hidRate: number
  log: LogRow[]

  set: (patch: Partial<AppState>) => void
  toggle: (key: 'autoReconnect' | 'relaying' | 'logPaused' | 'autoscroll' | 'rawMode') => void
}

export const useStore = create<AppState>((set) => ({
  tab: 'overview',
  sourceMode: 'bridge',
  transport: 'tcp',
  host: '192.168.85.25',
  port: '7778',
  autoReconnect: true,
  relaying: true,
  logPaused: false,
  autoscroll: true,
  rawMode: false,
  dirFilter: 'all',
  search: '',

  rpm: 84,
  ias: 142,
  flap: 50,
  alt: 14210,
  fuel: 62,
  bytesIn: 18240,
  bytesOut: 412,
  fps: 30,
  errors: 0,
  uptime: 4521,
  reconnects: 1,
  cmdsPerSec: 6,
  cmdsTotal: 1284,
  lastCmd: 'MASTER_ARM 1',
  axes: [4200, -1800, 22600, 0, 0, 0, -8000, 0],
  buttons: [0, 3, 12, 45, 88, 102],
  hats: [0, 8, 0, 3],
  hidRate: 125,
  log: seedLog(),

  set: (patch) => set(patch),
  toggle: (key) => set((s) => ({ [key]: !s[key] }) as Partial<AppState>)
}))

// ── pure helpers ────────────────────────────────────────────────────────────
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
