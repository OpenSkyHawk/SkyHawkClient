// A typed stand-in for the preload bridge (`window.skyhawk`), the renderer's whole boundary to main.
//
// ── Mock design rule: scenarios go in at main's push level ─────────────────────────────────────
//
// A component test describes the world as main sees it — a `Scenario`: the device link, the relay,
// the node model and PDU telemetry, the config, the session's events, … — and feeds it through ONE
// path, `emitScenario(scenario)`. That path does exactly what main does today:
//   - it keeps the scenario as main's current state, so the pulls a (re)loaded renderer makes
//     (`getStatus`, `getNodes`, `getConfig`, `getEvents`, `getNodeRegistry`) answer from it, and
//   - it pushes each part on today's channel: `device:status`, `relay:state`, `nodes:model`,
//     `nodes:telemetry`, `events:batch`, `cal:data`, `hid:report`, `aircraft:changed`, the relay's
//     ticks `telemetry:tick` and `stats:tick`, and the stream batches `log:batch` and
//     `serial:traffic` — and hands the link's state, the device's calibration report and the RAW
//     batches to main's calibration workflow, which pushes `cal:workflow`.
// Tests never set renderer store fields and never push channels by hand, so they assert what the
// user sees for a given main-side situation — not how the renderer stores it.
//
// When the rewrite moves a decision into main and adds a push for it (R3: `cockpit:snapshot`,
// `cal:workflow`, …), main gets a pure builder for that push. `emitScenario` then derives the new
// push by calling that builder on the same scenario inputs and sends it alongside (or instead of)
// today's channels. The change stays inside this file: every component test keeps its scenarios
// and its assertions unchanged.
//
// The Cockpit tab draws main's own snapshot (R3.2): the mock hosts a real CockpitSnapshotHost — the
// pure builder main pushes `cockpit:snapshot` from, its peak W and its stray timer — on the test's
// clock and timers. It is handed what main would hand it, in the same steps: each `nodes:model` and
// `nodes:telemetry` push and each `device:status` push (the link and the Gateway's health), and
// the renderer's load (`getStatus`, main's relay:status). The Overview, Connection and Settings
// read their sections of the same snapshot (R3.2b); the registry it lists is the scenario's, as
// `getNodeRegistry` answers it.
//
// "Add all" and "Un-hide all" run main's own sequence (R3.2b): `addAllNodes` / `unhideNodes` go
// through NodeHub's loop (mapping-sequence), one `adoptNode` / `hideNode` per board — the same
// spies, so a test still sees (and can refuse) each board's call.
//
// Calibration runs main's own workflow (R3.1): the mock hosts a real CalibrationWorkflowHost — the
// workflow, the dialog's start/close sequencing, the restore offer and the derived CalibrationState
// main pushes on `cal:workflow` — on the test's clock and timers. Its protocol commands are the one
// part with a scripted answer: a `CalDevice` is the Gateway's side of the protocol (what HELLO,
// GET_CAL, SESSION_OPEN, STREAM_SELECT, COMMIT and RESET answer), plus the client's restore cache
// on disk. The `cal*` commands (spies on the mock, so a test can assert the exchange) answer the
// way main's HidCalibrationService does over it — `offline` while the port is closed, GET_CAL also
// pushing `cal:data` and reporting to the workflow, the cache keyed by the board's serial through
// main's own cache rules — and the RAW stream arrives as `calRaw` batches into the workflow. The
// renderer's dialog sends the workflow intents (`calOpen`, `calSave`, …), which the host answers.
//
// Intents (renderer → main requests) are `vi.fn`s with harmless defaults, so a test can assert the
// call (`expect(sky.forgetNode).toHaveBeenCalledWith(4)`) or override the answer
// (`sky.forgetNode.mockResolvedValueOnce({ ok: false, error: '…' })`). The type follows
// `SkyhawkApi`, so an IPC change breaks the mock at typecheck, not at run time.
import { act } from '@testing-library/react'
import { vi, type Mock } from 'vitest'
import { DEFAULT_CONFIG, type AppConfig, type ConfigChanged, type ConfigEdit } from '@shared/config'
import type {
  AircraftStatus,
  CaptureState,
  LogRow,
  RelayFacts,
  RelayState,
  ReplayLoad,
  StatsSnapshot,
  TelemetryReadout
} from '@shared/dcs'
import type {
  CalCache,
  CalFailure,
  CalHello,
  CalRawSample,
  CalResult,
  CalSnapshot
} from '@shared/hid/calibration'
import type { DeviceStatus, DeviceStatusPush, SerialFrame } from '@shared/gateway'
import type { HidAvailability, HidReport, HidSnapshot } from '@shared/hid'
import { HID_REPORT_LAYOUT } from '@shared/firmware'
import { hidFacts } from '../../main/hid/hid-facts'
import {
  boardFor,
  dropAxis,
  emptyCache,
  regressedAxes,
  storeAxes
} from '../../main/hid/calibration/cache-rules'
import type { CalibrationCommands } from '../../main/hid/calibration/calibration-workflow'
import { CalibrationWorkflowHost } from '../../main/hid/calibration/workflow-host'
import { CockpitSnapshotHost } from '../../main/nodes/cockpit-host'
import { isLinkUp, LinkDownClock, linkFacts } from '../../main/gateway/link-state'
import { shownStatus } from '../../main/gateway/gateway-health'
import { canRequestRoster } from '../../main/nodes/node-status-wire'
import { captureView, relayFacts, replayView } from '../../main/dcs/relay-rules'
import { savedEdit } from '../../main/config/settings-form'
import { resolvePsu } from '../../main/nodes/psu-limits'
import { addAllInTurn, unhideInTurn } from '../../main/nodes/mapping-sequence'
import type { NodeModel, NodeRegistryInfo, NodeTelemSnapshot } from '@shared/nodes'
import type { PushChannel, PushChannels, SkyhawkApi } from '@shared/app'
import type { LogEvent } from '@shared/events'

/** What main knows right now. Every field is optional: absent = main's state at launch. */
export interface Scenario {
  /** The device link, Gateway health included (`device:status`). */
  device?: DeviceStatus
  /** The relay (`relay:state`). */
  relay?: RelayState
  /** Roster + telemetry + mapping, combined (`nodes:model`). */
  model?: NodeModel
  /** Latest PDU pages (`nodes:telemetry`). */
  telemetry?: NodeTelemSnapshot[]
  /** Saved settings, over the defaults (`getConfig`; main has no config push). */
  config?: Partial<AppConfig>
  /** The session's event log rows, oldest first (`events:batch`). */
  events?: LogEvent[]
  /** Calibration the device confirmed (`cal:data`). */
  cal?: CalSnapshot
  /** The latest HID report (`hid:report`). */
  hid?: HidSnapshot
  /** The aircraft DCS reports (`aircraft:changed`). */
  aircraft?: AircraftStatus
  /** The five sim-telemetry readouts of the last telemetry tick (`telemetry:tick`). */
  gauges?: TelemetryReadout[]
  /** The relay's last stats tick (`stats:tick`). */
  stats?: StatsSnapshot
  /** The bundled NODE_IDS.md (`getNodeRegistry`; never pushed). */
  registry?: NodeRegistryInfo
  /** What HIDControls.h catalogues (`getHidAvailability`; never pushed). */
  hidAvailability?: HidAvailability
  /**
   * The attached Gateway's calibration channel and the client's restore cache: what the `cal*`
   * invokes answer while the port is open. Main reads it when the port opens, so it also pushes
   * `cal:data` (the stored calibration) unless the scenario gives `cal` itself.
   */
  calDevice?: CalDevice
  /** DCS-BIOS stream rows, oldest first (`log:batch`). A batch: pushed, never pulled. */
  stream?: LogRow[]
  /** Raw serial chunks (`serial:traffic`). A batch: pushed, never pulled. */
  serial?: SerialFrame[]
  /** RAW samples for the streamed axis, stamped on arrival in main (its 50 ms batches). A batch. */
  calRaw?: CalRawSample[]
}

/** The Gateway's side of the calibration protocol (#46), as the cal* invokes reach it. */
export interface CalDevice {
  /** HELLO_ACK. */
  hello: CalHello
  /** What the device holds: GET_CAL answers with it. COMMIT and RESET change it. */
  stored: CalSnapshot
  /** The client's calibration cache file (cal-cache.json), keyed by board serial. */
  cache?: CalCache
  /** A request the device refuses (NACK) or never answers (timeout), instead of acknowledging. */
  refuse?: Partial<Record<'session' | 'stream' | 'commit' | 'reset', CalFailure>>
}

type Fns = { [K in keyof SkyhawkApi]: Mock<SkyhawkApi[K]> }

/** Main's calibration commands (HidCalibrationService), as the workflow calls them: spies. */
type CalCommands = CalibrationCommands & { calHello(): Promise<CalResult<CalHello>> }
type CalSpies = { [K in keyof CalCommands]: Mock<CalCommands[K]> }

export type SkyhawkMock = Fns &
  CalSpies & {
    /** Main's current state: what the pulls answer from. Grows with each `emitScenario`. */
    readonly scenario: Scenario
    /**
     * Main's state changes: merge `s` into the scenario and push each part it holds, in the order
     * main's session would (device link first). Wrapped in `act`, so the UI has caught up on return.
     */
    emitScenario(s: Scenario): void
  }

const EMPTY_MODEL: NodeModel = {
  nodes: [],
  outages: [],
  differingCount: 0,
  hidden: [],
  hiddenNodes: [],
  rosterComplete: false
}

const EMPTY_REGISTRY: NodeRegistryInfo = {
  file: 'Firmware/NODE_IDS.md',
  commit: '0000000',
  date: '2026-01-01',
  nodes: []
}

/** What the renderer is told the firmware catalogues when a scenario says nothing. */
const NO_CATALOGUE: HidAvailability = { axes: [], hats: [], buttons: [] }

/** Today's push for each scenario part, in the order emitScenario sends them. */
const PUSHES: { [K in keyof Scenario]?: PushChannel } = {
  device: 'device:status',
  relay: 'relay:state',
  aircraft: 'aircraft:changed',
  gauges: 'telemetry:tick',
  stats: 'stats:tick',
  model: 'nodes:model',
  telemetry: 'nodes:telemetry',
  events: 'events:batch',
  cal: 'cal:data',
  hid: 'hid:report',
  stream: 'log:batch',
  serial: 'serial:traffic'
}

/** Main's answer to any calibration exchange while the port is closed (HidCalibrationService). */
const OFFLINE = { ok: false, kind: 'offline', message: 'Gateway is not connected' } as const

/**
 * `spy`, and what main does once its answer is in (`then`): a spy a test can still drive
 * (`mockResolvedValueOnce`), whose answer main acts on as well — the push that follows it.
 */
function after<F extends (...a: never[]) => Promise<unknown>>(
  spy: Mock<F>,
  then: (r: Awaited<ReturnType<F>>) => void
): Mock<F> {
  return new Proxy(spy, {
    apply(target, self, args) {
      const p = Reflect.apply(target, self, args) as Promise<Awaited<ReturnType<F>>>
      void p.then((r: Awaited<ReturnType<F>>) => then(r))
      return p
    }
  })
}

/** Install a fresh mock as `window.skyhawk` (the setup file does this before every test). */
export function installSkyhawkMock(): SkyhawkMock {
  const listeners = new Map<PushChannel, Set<(d: never) => void>>()
  let state: Scenario = {}
  const resolve = <T>(v: T) => Promise.resolve(v)
  const calFail = { ok: false, kind: 'offline', message: 'mock' } as const

  const fns: Fns = {
    on: vi.fn<SkyhawkApi['on']>((ch, cb) => {
      const set = listeners.get(ch) ?? new Set()
      set.add(cb as (d: never) => void)
      listeners.set(ch, set)
      return () => {
        set.delete(cb as (d: never) => void)
      }
    }),

    // ── pulls: answered from the scenario ──
    getConfig: vi.fn(() => resolve({ config: config(), psu: resolvePsu(config().psu) })),
    getStatus: vi.fn(() => {
      host.rendererLoaded() // main's relay:status handler: a renderer (re)loaded
      // …and the Cockpit snapshot starts over from what main holds. Main's push reaches a page that
      // has subscribed by then (IPC is asynchronous); here the push waits for the same.
      void Promise.resolve().then(() =>
        cockpit.rendererLoaded(state.model ?? EMPTY_MODEL, state.telemetry ?? [])
      )
      // …and HidService hands it the report with its live axes (R3.3), on the same terms.
      void Promise.resolve().then(() => push('hid:report', hidPush()))
      // …and what the old page held for itself starts over (GatewayConnection, SerialTrafficMonitor,
      // DcsRelay).
      linkDown.pageLoaded(device().state)
      monitorShown = false
      recordingShown = { on: false }
      replayShown = undefined
      factsKey = JSON.stringify(relayFactsNow())
      return resolve({
        running: state.relay?.running ?? false,
        relay: state.relay ?? { running: false },
        relayFacts: relayFactsNow(),
        device: devicePush(),
        cal: host.state()
      })
    }),
    getNodes: vi.fn(() =>
      resolve({ model: state.model ?? EMPTY_MODEL, telemetry: state.telemetry ?? [] })
    ),
    getEvents: vi.fn(() => resolve(state.events ?? [])),
    getNodeRegistry: vi.fn(() => resolve(state.registry ?? EMPTY_REGISTRY)),
    getHidAvailability: vi.fn(() => resolve(state.hidAvailability ?? NO_CATALOGUE)),

    // ── intents: harmless defaults ──
    setConfig: vi.fn((p: Partial<AppConfig>) =>
      resolve({ ...DEFAULT_CONFIG, ...state.config, ...p })
    ),
    // ── a form's settings change: main's SettingsService builds the save (settings-form.ts) and
    //    applies it — `setConfig`, the spy, stands for that apply — then pushes `config:changed` ──
    editConfig: vi.fn((edit: ConfigEdit) => editSettings(edit)),
    exportConfig: vi.fn(() => resolve({ outcome: 'canceled' as const })),
    openConfigImport: vi.fn(() => resolve({ status: 'canceled' as const })),
    // An applied import: main's settings are what it answered, and its forms start over from them.
    applyConfigImport: after(
      vi.fn<SkyhawkApi['applyConfigImport']>(() => resolve({ ok: false as const, error: 'mock' })),
      (r: Awaited<ReturnType<SkyhawkApi['applyConfigImport']>>) => {
        if (!r.ok) return
        state = { ...state, config: r.config }
        pushFacts() // the relay's facts follow the settings (AppServices' settings subscriber)
        push('config:changed', configChanged('import'))
      }
    ),
    startRelay: vi.fn(() => resolve({ ok: true })),
    stopRelay: vi.fn(() => resolve({ ok: true })),
    // ── the relay's on/off: main's DcsRelay.toggle — Stop, or save the settings then Start — over
    //    the spies above, so a test still sees (and can refuse) the Start ──
    toggleRelay: vi.fn((relaying: boolean) =>
      relaying ? fns.stopRelay() : editSettings({}).then(() => fns.startRelay())
    ),
    connectDevice: vi.fn(() => resolve(undefined)),
    disconnectDevice: vi.fn(() => resolve(undefined)),
    exportLog: vi.fn(() => resolve({})),
    clearEvents: vi.fn(() => resolve(undefined)),
    exportEvents: vi.fn(() => resolve({})),
    // The Record controls and the Capture card follow main's answer (DcsRelay, `relay:facts`).
    toggleCapture: after(
      vi.fn<SkyhawkApi['toggleCapture']>(() => resolve({ recording: false })),
      (r: CaptureState) => {
        recordingShown = captureView(r)
        pushFacts()
      }
    ),
    openReplay: after(
      vi.fn<SkyhawkApi['openReplay']>(() => resolve({ loaded: false })),
      (r: ReplayLoad) => {
        replayShown = replayView(r, replayShown)
        pushFacts()
      }
    ),
    refreshNodes: vi.fn(() => resolve(undefined)),
    setNodeMapping: vi.fn(() => resolve(mapped())),
    adoptNode: vi.fn(() => resolve(mapped())),
    forgetNode: vi.fn(() => resolve(mapped())),
    resetNode: vi.fn(() => resolve(mapped())),
    resetNodeMapping: vi.fn(() => resolve(mapped())),
    previewNodeReset: vi.fn(() => resolve({ rows: [], nodeCount: 0, adopted: [] })),
    hideNode: vi.fn(() => resolve(mapped())),
    // ── node-mapping sequences: main's loop, over the per-board intents above ──
    addAllNodes: vi.fn((bulk) => addAllInTurn(bulk, (id, spec) => fns.adoptNode(id, spec))),
    unhideNodes: vi.fn((ids) => unhideInTurn(ids, (id, on) => fns.hideNode(id, on))),
    // Main's SerialTrafficMonitor: the page's flag comes back on `device:status`.
    setSerialMonitor: vi.fn((on: boolean) => {
      monitorShown = on
      act(() => push('device:status', statusPush()))
      return resolve(undefined)
    }),
    dumpSerialPorts: vi.fn(() => resolve({ path: '/tmp/serial-ports.txt', count: 0 })),
    revealDebugLog: vi.fn(() => resolve(undefined)),
    // ── calibration intents: main's workflow answers them (the host below) ──
    calOpen: vi.fn((axis: number, review?: boolean) => host.open(axis, review)),
    calClose: vi.fn(() => host.close()),
    calSelectAxis: vi.fn((axis: number) => host.selectAxis(axis)),
    calStartCapture: vi.fn(() => resolve(host.startCapture())),
    calRetry: vi.fn(() => resolve(host.retry())),
    calSetSelfCentring: vi.fn((on: boolean) => resolve(host.setSelfCentring(on))),
    calSave: vi.fn(() => host.save()),
    calRestore: vi.fn(() => host.restore()),
    calDeleteAxis: vi.fn((idx: number) => host.deleteAxis(idx)),
    calSetRestoreOpen: vi.fn((open: boolean) => resolve(host.setRestoreOpen(open))),
    calAttach: vi.fn((on: boolean) => resolve(host.attach(on)))
  }

  // ── main's calibration commands, over the scripted Gateway (HidCalibrationService's cal*) ──
  const calSpies: CalSpies = {
    calHello: vi.fn(() => resolve(cal((d) => ok(d.hello)) ?? calFail)),
    calRead: vi.fn(() => resolve(cal((d) => ok(readCal(d))) ?? calFail)),
    calSessionOpen: vi.fn((axisIdx: number) =>
      resolve(cal((d) => refused(d, 'session') ?? ok({ timeoutMs: 30_000, axisIdx })) ?? calFail)
    ),
    calStreamSelect: vi.fn(() => resolve(cal((d) => refused(d, 'stream') ?? ok(null)) ?? calFail)),
    calCommit: vi.fn((a) =>
      resolve(
        cal((d) => {
          const no = refused(d, 'commit')
          if (no) return no
          const { idx, min, centre, max } = a
          setStored(d, (x) => (x.idx === idx ? { ...x, min, centre, max, calibrated: true } : x))
          return ok(null)
        }) ?? calFail
      )
    ),
    calReset: vi.fn((idx: number) =>
      resolve(
        cal((d) => {
          const no = refused(d, 'reset')
          if (no) return no
          setStored(d, (x) => (idx === 0xff || x.idx === idx ? { ...x, calibrated: false } : x))
          return ok(null)
        }) ?? calFail
      )
    ),
    calSessionClose: vi.fn(() =>
      resolve(cal(() => ok(null)) ?? { ok: true as const, value: null })
    ),
    calCacheRead: vi.fn(() =>
      resolve(
        cal((d) => {
          const cache = d.cache ?? emptyCache()
          return ok({ board: boardFor(cache, serial(d)), regressed: regressedAxes(cache, lastCal) })
        }, true) ?? { ok: true as const, value: { regressed: [] } }
      )
    ),
    calCacheStore: vi.fn((axes) =>
      resolve(
        cal((d) => {
          const s = serial(d)
          if (s && axes.length) {
            const entries = Object.fromEntries(axes.map(({ idx, ...a }) => [idx, a]))
            setCache(storeAxes(d.cache ?? emptyCache(), s, entries, new Date().toISOString()))
          }
          return ok(null)
        }, true) ?? { ok: true as const, value: null }
      )
    ),
    calCacheDrop: vi.fn((idx: number) =>
      resolve(
        cal((d) => {
          const s = serial(d)
          if (s) setCache(dropAxis(d.cache ?? emptyCache(), s, idx === 0xff ? undefined : idx))
          return ok(null)
        }, true) ?? { ok: true as const, value: null }
      )
    )
  }

  // ── the device link, as main's GatewayConnection pushes it (link-state.ts) ──
  const device = (): DeviceStatus => state.device ?? { state: 'no-device' }
  /** The Cockpit's "last known" time and the serial monitor's flag: the page's, kept in main. */
  const linkDown = new LinkDownClock()
  let monitorShown = false
  /**
   * NodeHub's roster guard, for Refresh (R3.4a). A port is held from connect() until it is
   * released — every state but `disconnected` (GatewayConnection.attached).
   */
  const canRefresh = (): boolean =>
    canRequestRoster(device().state !== 'disconnected', device().state)
  /**
   * The status with what main concludes from it, as the last push carried it: the Gateway's
   * health only while the link is up (shownStatus, R3.4a).
   */
  const devicePush = (): DeviceStatusPush => ({
    ...shownStatus(device()),
    ...linkFacts(
      device(),
      { linkDownAt: linkDown.value, serialMonitor: monitorShown },
      canRefresh()
    )
  })
  /** One `device:status` push, judged as GatewayConnection judges each. */
  const statusPush = (): DeviceStatusPush => {
    linkDown.pushed(device().state)
    return devicePush()
  }

  // ── the settings, as main's SettingsService holds and pushes them ──
  const config = (): AppConfig => ({ ...DEFAULT_CONFIG, ...state.config })
  /**
   * A form's change: SettingsService builds the save (settings-form.ts) and applies it —
   * `setConfig`, the spy, stands for that apply — the relay's facts follow, then `config:changed`.
   */
  const editSettings = (edit: ConfigEdit): Promise<AppConfig> => {
    const built = savedEdit(config(), edit)
    // A refused PSU limit: nothing saved, nothing pushed (SettingsService.edit).
    if (built === undefined) return resolve(config())
    const saved = fns.setConfig(built)
    state = { ...state, config: { ...config(), ...built } }
    act(() => {
      pushFacts()
      push('config:changed', configChanged('edit'))
    })
    return saved
  }

  // ── the relay's facts, as main's DcsRelay pushes them (relay-rules.ts) ──
  /** The recording and the capture as the page set them; a reloaded page starts over (N1). */
  let recordingShown: RelayFacts['recording'] = { on: false }
  let replayShown: RelayFacts['replay']
  let factsKey: string | undefined
  const relayFactsNow = (): RelayFacts =>
    relayFacts({
      config: config(),
      stream: state.relay?.stream,
      deviceState: device().state,
      linkUp: isLinkUp(device().state),
      recording: recordingShown,
      replay: replayShown
    })
  /** `relay:facts`, when they changed. */
  const pushFacts = (): void => {
    const f = relayFactsNow()
    const key = JSON.stringify(f)
    if (key === factsKey) return
    factsKey = key
    push('relay:facts', f)
  }
  const configChanged = (source: ConfigChanged['source']): ConfigChanged => ({
    config: config(),
    psu: resolvePsu(config().psu),
    source
  })

  /** A mapping intent main accepted: it answers with the model (and would push it). */
  const mapped = () => ({ ok: true as const, model: state.model ?? EMPTY_MODEL })

  const push = <C extends PushChannel>(ch: C, data: PushChannels[C]): void => {
    for (const cb of listeners.get(ch) ?? []) (cb as (d: PushChannels[C]) => void)(data)
  }

  // ── the calibration channel, as main's HidCalibrationService answers it ──
  const ok = <T>(value: T) => ({ ok: true as const, value })
  /** The board's USB serial: what main reads from the port and keys the cache on. */
  const serial = (d: CalDevice) => d.stored.serialNumber
  /** GET_CAL as main returns it: the stored calibration with the serial. */
  const snapshotOf = (d: CalDevice): CalSnapshot => structuredClone(d.stored)
  /** The snapshot main last read (its `lastCal`): what the cache's regressed axes compare with. */
  let lastCal: CalSnapshot | undefined
  /**
   * Run `fn` against the scripted device. undefined = no device scripted (today's defaults). The
   * device answers only while the port is open; the cache is a local file and answers anyway.
   */
  const cal = <T>(fn: (d: CalDevice) => CalResult<T>, local = false): CalResult<T> | undefined => {
    const d = state.calDevice
    if (!d) return undefined
    if (!local && state.device?.state !== 'connected') return OFFLINE
    return fn(d)
  }
  const readCal = (d: CalDevice): CalSnapshot => {
    const snap = snapshotOf(d)
    lastCal = snap
    state = { ...state, cal: snap }
    // main's calRead pushes what it read, and reports it to the workflow
    act(() => {
      push('cal:data', snap)
      host.reported(snap)
    })
    return snap
  }
  const setStored = (
    d: CalDevice,
    f: (a: CalSnapshot['axes'][number]) => CalSnapshot['axes'][number]
  ) => {
    const axes = d.stored.axes.map(f)
    const calibratedMask = axes.reduce((m, a) => (a.calibrated ? m | (1 << a.idx) : m), 0)
    state = { ...state, calDevice: { ...d, stored: { ...d.stored, axes, calibratedMask } } }
  }
  const setCache = (cache: CalCache) => {
    state = { ...state, calDevice: { ...state.calDevice!, cache } }
  }
  /** The device's answer to a request it was scripted to refuse; undefined = it acknowledges. */
  const refused = (d: CalDevice, req: keyof NonNullable<CalDevice['refuse']>) => {
    const f = d.refuse?.[req]
    return f && ({ ok: false as const, ...f } satisfies CalResult<never>)
  }

  // ── the HID report, as main's HidService pushes it (hid-facts.ts) ──
  /** Before any report: what the renderer starts from (the reader has nothing yet). */
  const NO_REPORT: HidSnapshot = {
    axes: Array(HID_REPORT_LAYOUT.axes.count).fill(0),
    buttons: Array(HID_REPORT_LAYOUT.buttons.count).fill(false),
    hats: Array(HID_REPORT_LAYOUT.hats.count).fill(0),
    ageMs: 0,
    rateHz: 0
  }
  /** What the device declares, as calibration last pushed it (`cal:workflow`). */
  let hidCal: CalSnapshot | undefined
  const hidPush = (): HidReport => {
    const h = state.hid ?? NO_REPORT
    return { ...h, ...hidFacts(h.ageMs, hidCal, (state.hidAvailability ?? NO_CATALOGUE).axes) }
  }

  /** Main's calibration workflow (HidCalibrationService hosts the same), over the spies above. */
  const host = new CalibrationWorkflowHost(calSpies, (st) => {
    push('cal:workflow', st)
    // HidService follows what the device declares, after the push (AppServices).
    if (st.tab.snapshot !== hidCal) {
      hidCal = st.tab.snapshot
      push('hid:report', hidPush())
    }
  })

  /** Main's Cockpit snapshot (NodeHub hosts the same), over the scenario as main holds it. */
  const cockpit = new CockpitSnapshotHost((snap) => push('cockpit:snapshot', snap), {
    device: () => state.device ?? { state: 'no-device' },
    registry: () => state.registry ?? EMPTY_REGISTRY
  })

  const mock = Object.defineProperty(Object.assign(fns, calSpies), 'scenario', {
    get: () => state
  }) as SkyhawkMock
  Object.assign(mock, {
    emitScenario(given: Scenario) {
      // The port opened on a calibration-capable Gateway: main reads its calibration (GET_CAL)
      // and pushes it, unless the scenario says what main pushed.
      const device = given.calDevice ?? state.calDevice
      const opened = device && given.device?.state === 'connected'
      const s = opened && given.cal === undefined ? { ...given, cal: snapshotOf(device) } : given
      if (opened) lastCal = s.cal
      state = { ...state, ...s }
      act(() => {
        for (const [key, ch] of Object.entries(PUSHES) as [keyof Scenario, PushChannel][]) {
          const data = s[key]
          if (data === undefined) continue
          // `device:status` and `hid:report` carry what main concludes from them (R3.3).
          push(ch, (key === 'device' ? statusPush() : key === 'hid' ? hidPush() : data) as never)
          // What main does next, inside the same step: the workflow follows the link's state
          // (onStatus, after `device:status`) and takes the report (calRead, after `cal:data`);
          // the Cockpit snapshot follows the link and each node push (NodeHub).
          if (key === 'device') host.linkStatus(s.device!.state)
          if (key === 'device') cockpit.linkChanged()
          // The relay's facts follow its state and the link (DcsRelay, R3.3).
          if (key === 'device' || key === 'relay') pushFacts()
          if (key === 'model') cockpit.modelPushed(s.model!)
          if (key === 'telemetry') cockpit.telemetryPushed(s.telemetry!)
          if (key === 'cal') host.reported(s.cal!)
        }
        // RAW: main's 50 ms batches, into the workflow (main-internal since R3.1).
        if (s.calRaw !== undefined) host.ingest(s.calRaw)
      })
    }
  })
  ;(window as unknown as { skyhawk: SkyhawkApi }).skyhawk = mock
  return mock
}

/** The mock the setup file installed for this test. */
export function skyhawk(): SkyhawkMock {
  return (window as unknown as { skyhawk: SkyhawkMock }).skyhawk
}
