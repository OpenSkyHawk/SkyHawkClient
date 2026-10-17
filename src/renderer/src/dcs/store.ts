// The relay, the DCS-BIOS stream and its stats as main pushes them (R3.4b: the dcs slice of the old
// single store, cut verbatim). The IPC adapter binds the intents and delivers the pushes.
import { create } from 'zustand'
import type { RelayStatus, SkyhawkApi } from '@shared/app'
import { fmtTime, hex4 } from '@shared/format'
import {
  AIRCRAFT_NONE,
  RELAY_FACTS_IDLE,
  TELEMETRY_IDLE,
  type AircraftStatus,
  type LogRow as IpcLogRow,
  type RelayFacts,
  type RelayState,
  type StatsSnapshot,
  type StreamState,
  type TelemetryReadout
} from '@shared/dcs'
import { useEventsStore } from '../events'
import { rawHex, type DirFilter, type LogRow } from './stream-view'

const MAX_LOG = 1000

export interface DcsState {
  /**
   * The on/off as shown: set at once by a click (the pending Start or Stop), then as main pushes
   * `relay:state`, and taken back when main refuses a Start.
   */
  relaying: boolean
  /** Where the DCS-BIOS stream stands while relaying; undefined when stopped. */
  relayStream?: StreamState
  /**
   * What the relay's surfaces show, as main decides it (`relay:facts`, R3.3): for the relay shown
   * running and shown stopped, the endpoints, the recording and the loaded capture.
   */
  relayFacts: RelayFacts
  autoscroll: boolean
  rawMode: boolean
  dirFilter: DirFilter
  search: string
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

  log: LogRow[]
  private_logSeq: number

  set: (patch: Partial<DcsState>) => void
  toggle: (key: 'autoscroll' | 'rawMode') => void
  toggleRelay: () => void
  toggleCapture: () => void
  openReplay: () => void
  clearLog: () => void
  /** Resolves to where the file went; undefined when cancelled or empty. */
  exportLog: () => Promise<string | undefined>
}

/** Main, as the IPC adapter hands it over; nothing until it binds. */
let api: () => SkyhawkApi | undefined = () => undefined

/** The IPC adapter's binding: every intent reads `window.skyhawk` through it, at call time. */
export function bindDcs(skyhawk: () => SkyhawkApi | undefined): void {
  api = skyhawk
}

export const useDcsStore = create<DcsState>((set, get) => ({
  relaying: false,
  relayFacts: RELAY_FACTS_IDLE,
  autoscroll: true,
  rawMode: false,
  dirFilter: 'all',
  search: '',

  aircraft: AIRCRAFT_NONE,

  telemetry: TELEMETRY_IDLE,
  bytesIn: 0,
  bytesOut: 0,
  fps: 0,
  errors: 0,
  uptime: 0,
  reconnects: 0,
  cmdsPerSec: 0,
  cmdsTotal: 0,
  lastCmd: '—',

  log: [],
  private_logSeq: 1000,

  set: (patch) => set(patch),
  toggle: (key) =>
    set((s) => {
      const on = !s[key]
      return { [key]: on } as Partial<DcsState>
    }),

  // Main stops, or saves the settings and starts (`relay:toggle`, R3.3); the click shows at once.
  toggleRelay: () => {
    const s = get()
    void api()
      ?.toggleRelay(s.relaying)
      .then((r) => {
        // Main refuses a Start it cannot honour (no board for a mode that needs one) and pushes
        // no relay:state for it, so the pending Relaying has to be taken back here.
        if (!s.relaying && r && !r.ok) set({ relaying: false, relayStream: undefined })
      })
    set({ relaying: !s.relaying })
  },

  // The recording and the capture come back on `relay:facts` (R3.3).
  toggleCapture: () => {
    void api()?.toggleCapture()
  },

  openReplay: () => {
    void api()?.openReplay()
  },

  clearLog: () => set({ log: [] }),

  exportLog: async () => {
    const rows = get().log
    if (rows.length === 0) return undefined
    // oldest-first TSV
    const header = 'time\tdir\tcontrol\taddress\tvalue\traw'
    const body = [...rows]
      .reverse()
      .map((r) => [r.time, r.dir, r.name, r.addrHex, String(r.value), r.raw].join('\t'))
      .join('\n')
    return (await api()?.exportLog(`${header}\n${body}\n`))?.path
  }
}))

/** What main sends this slice; the IPC adapter calls each as its push or pull lands. */
export const dcsFromMain = {
  /**
   * The rehydrate bundle (`relay:status`): a dev reload resets the renderer but the main-process
   * session keeps running, so the UI must not assume "stopped".
   */
  status: (st: Pick<RelayStatus, 'running' | 'relay' | 'relayFacts'>): void =>
    useDcsStore.setState({
      relaying: st.running,
      relayStream: st.relay.stream,
      relayFacts: st.relayFacts
    }),

  /** `relay:state`. */
  relayState: (r: RelayState): void =>
    useDcsStore.setState({ relaying: r.running, relayStream: r.stream }),

  /** `relay:facts`. */
  relayFacts: (f: RelayFacts): void => useDcsStore.setState({ relayFacts: f }),

  /** `aircraft:changed`. */
  aircraft: (a: AircraftStatus): void => useDcsStore.setState({ aircraft: a }),

  /** `telemetry:tick`. */
  telemetry: (t: TelemetryReadout[]): void => useDcsStore.setState({ telemetry: t }),

  /** `stats:tick`. */
  stats: (st: StatsSnapshot): void =>
    useDcsStore.setState({
      bytesIn: st.bytesInPerSec,
      bytesOut: st.bytesOutPerSec,
      fps: st.framesPerSec,
      errors: st.errors,
      uptime: st.uptimeSec,
      reconnects: st.reconnects,
      cmdsPerSec: st.commandsPerSec,
      cmdsTotal: st.commandsTotal,
      lastCmd: st.lastCommand ?? '—'
    }),

  /** `log:batch`: dropped while the Log tab is paused (the pause is the events slice's). */
  logBatch: (rows: IpcLogRow[]): void => {
    const s = useDcsStore.getState()
    if (useEventsStore.getState().logPaused) return
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
    useDcsStore.setState({
      log: [...mapped.reverse(), ...s.log].slice(0, MAX_LOG),
      private_logSeq: seq
    })
  }
}
