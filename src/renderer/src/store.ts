import { create } from 'zustand'
import {
  DEVICE_IDLE,
  type DeviceState,
  type DeviceStatusPush,
  type GatewayStatus,
  type LinkAction,
  type SerialFrame
} from '@shared/gateway'
import { HID_CONTROLS_BY_ID, HID_ID, HID_REPORT_LAYOUT } from '@shared/firmware'
import type { HidFreshness } from '@shared/hid'
import { fmtTime, hex2, hex4 } from '@shared/format'
import {
  AIRCRAFT_NONE,
  RELAY_FACTS_IDLE,
  TELEMETRY_IDLE,
  type AircraftStatus,
  type LogRow as IpcLogRow,
  type RelayFacts,
  type StreamState,
  type TelemetryReadout
} from '@shared/dcs'
import {
  DEFAULT_CONFIG,
  PSU_VIEW_DEFAULT,
  type AppConfig,
  type ConfigEdit,
  type DcsTransport,
  type PsuView
} from '@shared/config'
import { CALIBRATION_IDLE, type CalibrationState } from '@shared/hid/calibration'
import {
  COCKPIT_IDLE,
  type CockpitSnapshot,
  type NodeModel,
  type NodeTelemSnapshot,
  type PsuSetting
} from '@shared/nodes'
import type { LogEvent } from '@shared/events'
import { mergeEvents, restoreEvents, type EventSourceFilter, type LogView } from './log-view'

export type TabId = 'overview' | 'connection' | 'cockpit' | 'log' | 'serial' | 'hid' | 'settings'

export interface SerialRow extends SerialFrame {
  id: number
}
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

/** Per HID axis slot: its HIDControls.h label, or "Spare" for a slot the firmware doesn't catalogue. */
export const AXIS_LABELS = Array.from(
  { length: HID_REPORT_LAYOUT.axes.count },
  (_, i) => HID_CONTROLS_BY_ID.get(HID_ID.AXIS_MIN + i)?.label ?? 'Spare'
)

// ── renderer <-> main transport mapping ──────────────────────────────────────
const TRANSPORT_TO_IPC: Record<Transport, DcsTransport> = {
  tcp: 'tcp-to-host',
  loop: 'loopback-multicast',
  uni: 'unicast-listen'
}

function rawHex(addr: number, value: number | string): string {
  const v = typeof value === 'number' ? Math.abs(value) & 0xffff : 0
  return `${hex2(addr >> 8)} ${hex2(addr)} ${hex2(v)} ${hex2(v >> 8)}`
}

const MAX_LOG = 1000
const MAX_SERIAL = 2000

// Guards against duplicate IPC subscriptions (React StrictMode double-mounts the
// init effect in dev; without this every push — and every log row — lands twice).
let bridgeSubscribed = false

export interface AppState {
  // UI state
  tab: TabId
  sourceMode: SourceMode
  transport: Transport
  host: string
  port: string
  autoConnect: boolean
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
  logPaused: boolean
  autoscroll: boolean
  rawMode: boolean
  dirFilter: DirFilter
  search: string
  /** Log tab sub-tab (#64): the DCS-BIOS stream, or the event log. */
  logView: LogView
  eventSource: EventSourceFilter
  /** NODE_ID whose Cockpit side panel opens when the Cockpit tab next mounts (#66). */
  cockpitOpen?: number
  /** The Cockpit's Adopt dialog opens when the Cockpit tab next mounts (#77). */
  cockpitAdopt?: boolean
  problemsOnly: boolean

  // live link state
  deviceState: DeviceState
  devicePort?: string
  /** Why the link is in `error` — e.g. another program holds the port. */
  deviceDetail?: string
  /** The Gateway's own health (#94); only while connected. */
  deviceGateway?: GatewayStatus
  /** The link is up, as main concludes it (`device:status`, R3.3). */
  linkUp: boolean
  /** The board is plugged in as far as the link can tell: HID reports can arrive (#74). */
  boardPresent: boolean
  /** The port would not open because another program holds it. */
  deviceBusy: boolean
  /** The device card's and the popover's button, as main offers it (`device:status`, R3.4a). */
  deviceAction: LinkAction
  /** A roster request can go out: Connection's Refresh (`device:status`, R3.4a). */
  canRefresh: boolean
  /** The title-bar Device popover is open — also opened by Overview's Details and Attention's cog (#94). */
  devicePopOpen: boolean
  aircraft: AircraftStatus
  /** Roster + telemetry + mapping, as main combines them (#61). Kept, dimmed, while the link is down. */
  nodeModel?: NodeModel
  nodeTelemetry: NodeTelemSnapshot[]
  /**
   * The Cockpit tab's picture as main pushes it (`cockpit:snapshot`, R3.2): views, plan zones, band
   * (peak W included), Attention, side panels and the Adopt queue. Kept, dimmed, while the link is down.
   */
  cockpit: CockpitSnapshot
  /**
   * When the device link last went down after being up — "last known" time on the Cockpit. Main
   * stamps it (`device:status`, R3.3).
   */
  linkDownAt?: number

  // replay
  replayDriveSerial: boolean

  // Cockpit options (#67)
  attentionBanner: boolean
  psu: PsuSetting
  /** What the PSU setting comes to — preset, limits, name — as main resolves it (R3.3). */
  psuView: PsuView

  // developer / debug
  debugMode: boolean
  debugDump?: { path: string; count: number }

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
  /** Since the last report, or since we began listening if none has arrived. */
  hidAgeMs: number
  /** The report's age as main bands it (`hid:report`, R3.3). */
  hidBand: HidFreshness
  /** Axis slots this Gateway declares, as main counts them (`hid:report`). */
  hidPresent: number
  /** Per axis slot: shown live (catalogued and declared), as main decides it (`hid:report`). */
  axisLive: boolean[]
  availHats: number[]
  availButtons: number[]

  /**
   * Axis calibration as main pushes it (`cal:workflow`): the device's stored calibration and the
   * HID tab's badges and offer, and the calibration dialog while it is open. Main runs the
   * workflow; the HID tab and the dialog only render this and send `calibrate` intents.
   */
  calibration: CalibrationState
  /** The calibration dialog's actions, sent to main. */
  calibrate: CalibrationIntents

  log: LogRow[]
  private_logSeq: number
  /** The session's events (#64), newest first. Main holds the same list; Clear empties both. */
  events: LogEvent[]
  /** Set while paused: the newest event id the Events view still shows. */
  eventsPauseMark?: number

  // raw serial monitor
  /** The Serial tab's monitor, as main reports this page last set it (`device:status`, R3.3). */
  serialMonitor: boolean
  serialLog: SerialRow[]
  private_serialSeq: number

  set: (patch: Partial<AppState>) => void
  toggle: (key: 'logPaused' | 'autoscroll' | 'rawMode') => void
  setConfigField: (
    patch: Partial<
      Pick<
        AppState,
        | 'sourceMode'
        | 'transport'
        | 'host'
        | 'port'
        | 'autoConnect'
        | 'replayDriveSerial'
        | 'debugMode'
        | 'attentionBanner'
        | 'psu'
      >
    >
  ) => void
  /** Settings › Cockpit's PSU switch: main switches the mode over the setting it holds (R3.4a). */
  setPsuMode: (mode: PsuSetting['mode']) => void
  toggleRelay: () => void
  /** Open the device link now (also the Retry after an error). */
  connectDevice: () => void
  /** Release the serial port until connectDevice(), even through a replug. */
  disconnectDevice: () => void
  toggleCapture: () => void
  openReplay: () => void
  clearLog: () => void
  /** Resolves to where the file went; undefined when cancelled or empty. */
  exportLog: () => Promise<string | undefined>
  clearEvents: () => void
  exportEvents: () => Promise<string | undefined>
  /** Log › Events, with a source filter — the Cockpit's "View all in Log →". */
  showEvents: (source: EventSourceFilter) => void
  /** The Cockpit tab with this node's side panel open — Connection's "›". */
  openInCockpit: (nodeId: number) => void
  /** The Cockpit tab with the Adopt dialog open — the Overview's new-devices notice. */
  openAdopt: () => void
  setSerialMonitor: (on: boolean) => void
  clearSerial: () => void
  refreshNodes: () => void
  dumpSerialPorts: () => void
  revealDebugLog: () => void
  initBridge: () => (() => void) | void
}

/** The calibration dialog's actions (R3.1): main runs the workflow and pushes `cal:workflow`. */
export interface CalibrationIntents {
  /** Open the dialog on `axis`; `review` expands the restore offer. */
  open(axis: number, review?: boolean): void
  close(): void
  selectAxis(axis: number): void
  startCapture(): void
  retry(): void
  setSelfCentring(selfCentring: boolean): void
  save(): void
  restore(): void
  deleteAxis(idx: number): void
  setRestoreOpen(open: boolean): void
  /** The HID tab mounted (`true`) or unmounted (`false`). */
  attach(on: boolean): void
}

/** The calibration intents, each a call to main. */
function calibrationIntents(): CalibrationIntents {
  const api = () => window.skyhawk
  return {
    open: (axis, review) => void api()?.calOpen(axis, review),
    close: () => void api()?.calClose(),
    selectAxis: (axis) => void api()?.calSelectAxis(axis),
    startCapture: () => void api()?.calStartCapture(),
    retry: () => void api()?.calRetry(),
    setSelfCentring: (selfCentring) => void api()?.calSetSelfCentring(selfCentring),
    save: () => void api()?.calSave(),
    restore: () => void api()?.calRestore(),
    deleteAxis: (idx) => void api()?.calDeleteAxis(idx),
    setRestoreOpen: (open) => void api()?.calSetRestoreOpen(open),
    attach: (on) => void api()?.calAttach(on)
  }
}

/** The store fields an AppConfig sets — on load, and after a config import replaces it. */
function configState(cfg: AppConfig): ConfigFields {
  const transport = (Object.keys(TRANSPORT_TO_IPC) as Transport[]).find(
    (k) => TRANSPORT_TO_IPC[k] === cfg.transport
  )
  return {
    sourceMode: cfg.sourceMode,
    transport: transport ?? 'tcp',
    host: cfg.host,
    port: String(cfg.commandPort),
    autoConnect: cfg.autoConnect,
    replayDriveSerial: cfg.replayDriveSerial,
    debugMode: cfg.debugMode,
    attentionBanner: cfg.attentionBanner,
    psu: cfg.psu
  }
}

/** The store fields `device:status` sets — on each push, and from the rehydrate bundle. */
function linkState(
  d: DeviceStatusPush
): Pick<
  AppState,
  | 'deviceState'
  | 'devicePort'
  | 'deviceDetail'
  | 'deviceGateway'
  | 'linkUp'
  | 'boardPresent'
  | 'deviceBusy'
  | 'deviceAction'
  | 'canRefresh'
  | 'linkDownAt'
  | 'serialMonitor'
> {
  return {
    deviceState: d.state,
    devicePort: d.portPath,
    deviceDetail: d.detail,
    deviceGateway: d.gateway,
    linkUp: d.linkUp,
    boardPresent: d.boardPresent,
    deviceBusy: d.busy,
    deviceAction: d.action,
    canRefresh: d.canRefresh,
    linkDownAt: d.linkDownAt,
    serialMonitor: d.serialMonitor
  }
}

/** The settings fields the forms edit, as the store holds them. */
type ConfigFields = Pick<
  AppState,
  | 'sourceMode'
  | 'transport'
  | 'host'
  | 'port'
  | 'autoConnect'
  | 'replayDriveSerial'
  | 'debugMode'
  | 'attentionBanner'
  | 'psu'
>

/** A form's change as main takes it (`config:edit`): the contract's transport, the port as typed. */
function configEdit(patch: Partial<ConfigFields>): ConfigEdit {
  const { transport, ...rest } = patch
  return { ...rest, ...(transport !== undefined && { transport: TRANSPORT_TO_IPC[transport] }) }
}

/** A form's change, to main (`config:edit`): main builds the settings and saves them (R3.3). */
const editConfig = (edit: ConfigEdit): void => void window.skyhawk?.editConfig(edit)

export const useStore = create<AppState>((set, get) => ({
  tab: 'overview',
  ...configState(DEFAULT_CONFIG),
  psuView: PSU_VIEW_DEFAULT,
  relaying: false,
  relayFacts: RELAY_FACTS_IDLE,
  logPaused: false,
  autoscroll: true,
  rawMode: false,
  dirFilter: 'all',
  search: '',
  logView: 'stream',
  eventSource: 'all',
  problemsOnly: false,

  ...linkState(DEVICE_IDLE),
  devicePopOpen: false,
  aircraft: AIRCRAFT_NONE,
  nodeTelemetry: [],
  cockpit: COCKPIT_IDLE,

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

  axes: Array(HID_REPORT_LAYOUT.axes.count).fill(0),
  buttons: [],
  hats: Array(HID_REPORT_LAYOUT.hats.count).fill(0),
  availHats: [],
  availButtons: [],
  hidRate: 0,
  hidAgeMs: 0,
  // A report 0 ms old reads live; no slot is live until main says so (as before the catalogue).
  hidBand: 'live',
  hidPresent: 0,
  axisLive: [],

  calibration: CALIBRATION_IDLE,
  calibrate: calibrationIntents(),

  log: [],
  private_logSeq: 1000,
  events: [],

  serialLog: [],
  private_serialSeq: 0,

  set: (patch) => set(patch),
  toggle: (key) =>
    set((s) => {
      const on = !s[key]
      // Pausing holds the Events view where it is; events keep being recorded meanwhile.
      if (key === 'logPaused')
        return { logPaused: on, eventsPauseMark: on ? (s.events[0]?.id ?? 0) : undefined }
      return { [key]: on } as Partial<AppState>
    }),

  // What is typed stays as typed; main builds and saves the settings (`config:edit`, R3.3).
  setConfigField: (patch) => {
    set(patch as Partial<AppState>)
    editConfig(configEdit(patch))
  },

  // The switched setting comes back on `config:changed` (R3.4a).
  setPsuMode: (mode) => {
    editConfig({ psuMode: mode })
  },

  // Main stops, or saves the settings and starts (`relay:toggle`, R3.3); the click shows at once.
  toggleRelay: () => {
    const s = get()
    void window.skyhawk?.toggleRelay(s.relaying).then((r) => {
      // Main refuses a Start it cannot honour (no board for a mode that needs one) and pushes
      // no relay:state for it, so the pending Relaying has to be taken back here.
      if (!s.relaying && r && !r.ok) set({ relaying: false, relayStream: undefined })
    })
    set({ relaying: !s.relaying })
  },

  connectDevice: () => {
    void window.skyhawk?.connectDevice()
  },

  disconnectDevice: () => {
    void window.skyhawk?.disconnectDevice()
  },

  // The recording and the capture come back on `relay:facts` (R3.3).
  toggleCapture: () => {
    void window.skyhawk?.toggleCapture()
  },

  openReplay: () => {
    void window.skyhawk?.openReplay()
  },

  dumpSerialPorts: () => {
    void window.skyhawk?.dumpSerialPorts().then((r) => set({ debugDump: r }))
  },

  revealDebugLog: () => {
    void window.skyhawk?.revealDebugLog()
  },

  refreshNodes: () => {
    void window.skyhawk?.refreshNodes()
  },

  clearLog: () => set({ log: [] }),

  // Main pushes the flag back on `device:status` (R3.3).
  setSerialMonitor: (on) => {
    void window.skyhawk?.setSerialMonitor(on)
  },

  clearSerial: () => set({ serialLog: [] }),

  exportLog: async () => {
    const rows = get().log
    if (rows.length === 0) return undefined
    // oldest-first TSV
    const header = 'time\tdir\tcontrol\taddress\tvalue\traw'
    const body = [...rows]
      .reverse()
      .map((r) => [r.time, r.dir, r.name, r.addrHex, String(r.value), r.raw].join('\t'))
      .join('\n')
    return (await window.skyhawk?.exportLog(`${header}\n${body}\n`))?.path
  },

  clearEvents: () => {
    set({ events: [], eventsPauseMark: get().logPaused ? 0 : undefined })
    void window.skyhawk?.clearEvents()
  },

  exportEvents: async () => {
    if (get().events.length === 0) return undefined
    return (await window.skyhawk?.exportEvents())?.path
  },

  showEvents: (source) => set({ tab: 'log', logView: 'events', eventSource: source }),

  openInCockpit: (nodeId) => set({ tab: 'cockpit', cockpitOpen: nodeId }),
  openAdopt: () => set({ tab: 'cockpit', cockpitAdopt: true }),

  initBridge: () => {
    const api = window.skyhawk
    if (!api || bridgeSubscribed) return // outside Electron, or already subscribed
    bridgeSubscribed = true

    void api.getHidAvailability().then((a) => set({ availHats: a.hats, availButtons: a.buttons }))

    // Node pushes only fire on change, so a reloaded renderer asks for the current picture.
    void api.getNodes().then(({ model, telemetry }) => setNodes(model, telemetry))

    void api.getConfig().then((v) => set({ ...configState(v.config), psuView: v.psu }))

    // Events live in main for the whole app run; a reloaded renderer picks the list back up.
    void api.getEvents().then((rows) => set({ events: restoreEvents(get().events, rows) }))

    // Rehydrate from the live session: a dev reload resets the renderer but the
    // main-process session keeps running, so the UI must not assume "stopped".
    void api.getStatus().then((st) =>
      set({
        relaying: st.running,
        relayStream: st.relay.stream,
        relayFacts: st.relayFacts,
        ...linkState(st.device),
        // The device's report is only pushed when the port opens. A renderer reload builds a
        // fresh store while the main-process session keeps running, so without carrying the
        // calibration here the badges would stay blank until the next reconnect — forever, on a
        // stable link.
        calibration: st.cal ?? CALIBRATION_IDLE
      })
    )

    const setNodes = (model: NodeModel | undefined, telemetry: NodeTelemSnapshot[]) => {
      set({ nodeModel: model, nodeTelemetry: telemetry })
    }

    const unsubs = [
      api.on('hid:report', (h) =>
        set({
          axes: h.axes,
          buttons: h.buttons.flatMap((b, i) => (b ? [i] : [])),
          hats: h.hats,
          hidRate: h.rateHz,
          hidAgeMs: h.ageMs,
          hidBand: h.band,
          hidPresent: h.present,
          axisLive: h.axisLive
        })
      ),
      api.on('device:status', (d) => set(linkState(d))),
      api.on('relay:state', (r) => set({ relaying: r.running, relayStream: r.stream })),
      api.on('relay:facts', (f) => set({ relayFacts: f })),
      api.on('cal:workflow', (c) => set({ calibration: c })),
      api.on('aircraft:changed', (a) => set({ aircraft: a })),
      api.on('nodes:model', (m) => setNodes(m, get().nodeTelemetry)),
      api.on('nodes:telemetry', (t) => setNodes(get().nodeModel, t)),
      api.on('cockpit:snapshot', (c) => set({ cockpit: c })),
      // An import replaced the settings: the forms start over from them. A form's own change
      // leaves what is typed alone (the port as typed, N5); the PSU setting is main's either way,
      // since main switches its mode (R3.4a).
      api.on('config:changed', (c) =>
        set({
          psuView: c.psu,
          psu: c.config.psu,
          ...(c.source === 'import' ? configState(c.config) : {})
        })
      ),
      api.on('serial:traffic', (frames) => {
        const s = get()
        let seq = s.private_serialSeq
        const mapped: SerialRow[] = frames.map((f) => ({ id: seq++, ...f }))
        set({
          serialLog: [...mapped.reverse(), ...s.serialLog].slice(0, MAX_SERIAL),
          private_serialSeq: seq
        })
      }),
      api.on('telemetry:tick', (t) => set({ telemetry: t })),
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
      ),
      api.on('events:batch', (rows) => set({ events: mergeEvents(get().events, rows) })),
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
    ]

    return () => {
      for (const off of unsubs) off()
      bridgeSubscribed = false
    }
  }
}))

// ── pure helpers ─────────────────────────────────────────────────────────────
export const HAT_DIRS = ['CTR', 'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
