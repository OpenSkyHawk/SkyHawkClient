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

// Idle gauges (value NaN -> "—") until live telemetry arrives.
const IDLE_TELEMETRY: TelemetryReadout[] = [
  { id: 'RPM', label: 'RPM', value: NaN, pct: 0, unit: '% RPM' },
  { id: 'D_IAS_DEG', label: 'IAS', value: NaN, pct: 0, unit: '% FS' },
  { id: 'D_FLAPS_IND', label: 'Flap', value: NaN, pct: 0, unit: '% DN' },
  { id: 'D_ALT_NEEDLE', label: 'Press Alt', value: NaN, pct: 0, unit: '% FS' },
  { id: 'D_FUEL', label: 'Fuel', value: NaN, pct: 0, unit: '% QTY' }
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
  devicePort?: string
  aircraft: AircraftStatus

  // record / replay
  recording: boolean
  recordEvents?: number
  replayFile?: string
  replayInfo?: { events: number; durationMs: number }
  replayDriveSerial: boolean

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

  // HID live state + which report indices the firmware catalogues (rest dim)
  axes: number[]
  buttons: number[]
  hats: number[]
  hidRate: number
  availAxes: number[]
  availHats: number[]
  availButtons: number[]

  log: LogRow[]
  private_logSeq: number

  set: (patch: Partial<AppState>) => void
  toggle: (key: 'logPaused' | 'autoscroll' | 'rawMode') => void
  setConfigField: (
    patch: Partial<
      Pick<
        AppState,
        'sourceMode' | 'transport' | 'host' | 'port' | 'autoReconnect' | 'replayDriveSerial'
      >
    >
  ) => void
  toggleRelay: () => void
  toggleCapture: () => void
  openReplay: () => void
  initBridge: () => void
}

function buildConfig(s: AppState): Partial<AppConfig> {
  return {
    sourceMode: s.sourceMode,
    transport: TRANSPORT_TO_IPC[s.transport],
    host: s.host,
    commandPort: Number(s.port) || 7778,
    autoReconnect: s.autoReconnect,
    replayDriveSerial: s.replayDriveSerial
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

  recording: false,
  replayDriveSerial: false,

  telemetry: IDLE_TELEMETRY,
  bytesIn: 0,
  bytesOut: 0,
  fps: 0,
  errors: 0,
  uptime: 0,
  reconnects: 0,
  cmdsPerSec: 0,
  cmdsTotal: 0,
  lastCmd: '—',

  axes: Array(8).fill(0),
  buttons: [],
  hats: [0, 0, 0, 0],
  availAxes: [],
  availHats: [],
  availButtons: [],
  hidRate: 0,

  log: [],
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

  toggleCapture: () => {
    void window.skyhawk
      ?.toggleCapture()
      .then((r) => set({ recording: r.recording, recordEvents: r.events }))
  },

  openReplay: () => {
    void window.skyhawk?.openReplay().then((r) => {
      if (r.loaded) {
        set({
          replayFile: r.path,
          replayInfo: { events: r.events ?? 0, durationMs: r.durationMs ?? 0 }
        })
      }
    })
  },

  initBridge: () => {
    const api = window.skyhawk
    if (!api) return // running outside Electron (tests / web preview)

    void api
      .getHidAvailability()
      .then((a) => set({ availAxes: a.axes, availHats: a.hats, availButtons: a.buttons }))

    void api.getConfig().then((cfg) => {
      const transport = (Object.keys(TRANSPORT_TO_IPC) as Transport[]).find(
        (k) => TRANSPORT_TO_IPC[k] === cfg.transport
      )
      set({
        sourceMode: cfg.sourceMode,
        transport: transport ?? 'tcp',
        host: cfg.host,
        port: String(cfg.commandPort),
        autoReconnect: cfg.autoReconnect,
        replayDriveSerial: cfg.replayDriveSerial
      })
    })

    api.on('hid:report', (h) =>
      set({
        axes: h.axes,
        buttons: h.buttons.flatMap((b, i) => (b ? [i] : [])),
        hats: h.hats,
        hidRate: h.rateHz
      })
    )
    api.on('device:status', (d) => set({ deviceState: d.state, devicePort: d.portPath }))
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
