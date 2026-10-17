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
//     ticks `telemetry:tick` and `stats:tick`, and the stream batches `log:batch`,
//     `serial:traffic` and `cal:raw`.
// Tests never set renderer store fields and never push channels by hand, so they assert what the
// user sees for a given main-side situation — not how the renderer stores it.
//
// When the rewrite moves a decision into main and adds a push for it (R3: `cockpit:snapshot`,
// `cal:workflow`, …), main gets a pure builder for that push. `emitScenario` then derives the new
// push by calling that builder on the same scenario inputs and sends it alongside (or instead of)
// today's channels. The change stays inside this file: every component test keeps its scenarios
// and its assertions unchanged.
//
// The calibration channel is the one intent set with a scripted answer: a `CalDevice` is the
// Gateway's side of the protocol (what HELLO, GET_CAL, SESSION_OPEN, STREAM_SELECT, COMMIT and
// RESET answer), plus the client's restore cache on disk. The `cal*` invokes answer the way
// main's HidCalibrationService does over it — `offline` while the port is closed, GET_CAL also
// pushing `cal:data`, the cache keyed by the board's serial through main's own cache rules — and
// the RAW stream arrives as `calRaw` batches. Nothing in the renderer's calibration controller is
// stubbed. (R3.1 moves the workflow into main; the same CalDevice answers then feed it here.)
//
// Intents (renderer → main requests) are `vi.fn`s with harmless defaults, so a test can assert the
// call (`expect(sky.forgetNode).toHaveBeenCalledWith(4)`) or override the answer
// (`sky.forgetNode.mockResolvedValueOnce({ ok: false, error: '…' })`). The type follows
// `SkyhawkApi`, so an IPC change breaks the mock at typecheck, not at run time.
import { act } from '@testing-library/react'
import { vi, type Mock } from 'vitest'
import { DEFAULT_CONFIG, type AppConfig } from '@shared/config'
import type {
  AircraftStatus,
  LogRow,
  RelayState,
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
import type { DeviceStatus, SerialFrame } from '@shared/gateway'
import type { HidAvailability, HidSnapshot } from '@shared/hid'
import {
  boardFor,
  dropAxis,
  emptyCache,
  regressedAxes,
  storeAxes
} from '../../main/hid/calibration/cache-rules'
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
  /** RAW samples for the streamed axis, stamped on arrival in main (`cal:raw`). A batch. */
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

export type SkyhawkMock = Fns & {
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
  serial: 'serial:traffic',
  calRaw: 'cal:raw'
}

/** Main's answer to any calibration exchange while the port is closed (HidCalibrationService). */
const OFFLINE = { ok: false, kind: 'offline', message: 'Gateway is not connected' } as const

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
    getConfig: vi.fn(() => resolve({ ...DEFAULT_CONFIG, ...state.config })),
    getStatus: vi.fn(() =>
      resolve({
        running: state.relay?.running ?? false,
        relay: state.relay ?? { running: false },
        device: state.device ?? { state: 'no-device' },
        ...(state.cal && { cal: state.cal })
      })
    ),
    getNodes: vi.fn(() =>
      resolve({ model: state.model ?? EMPTY_MODEL, telemetry: state.telemetry ?? [] })
    ),
    getEvents: vi.fn(() => resolve(state.events ?? [])),
    getNodeRegistry: vi.fn(() => resolve(state.registry ?? EMPTY_REGISTRY)),
    getHidAvailability: vi.fn(() =>
      resolve(state.hidAvailability ?? { axes: [], hats: [], buttons: [] })
    ),

    // ── intents: harmless defaults ──
    setConfig: vi.fn((p: Partial<AppConfig>) =>
      resolve({ ...DEFAULT_CONFIG, ...state.config, ...p })
    ),
    exportConfig: vi.fn(() => resolve({})),
    openConfigImport: vi.fn(() => resolve({ status: 'canceled' as const })),
    applyConfigImport: vi.fn(() => resolve({ ok: false as const, error: 'mock' })),
    startRelay: vi.fn(() => resolve({ ok: true })),
    stopRelay: vi.fn(() => resolve({ ok: true })),
    connectDevice: vi.fn(() => resolve(undefined)),
    disconnectDevice: vi.fn(() => resolve(undefined)),
    exportLog: vi.fn(() => resolve({})),
    clearEvents: vi.fn(() => resolve(undefined)),
    exportEvents: vi.fn(() => resolve({})),
    toggleCapture: vi.fn(() => resolve({ recording: false })),
    openReplay: vi.fn(() => resolve({ loaded: false })),
    refreshNodes: vi.fn(() => resolve(undefined)),
    setNodeMapping: vi.fn(() => resolve(mapped())),
    adoptNode: vi.fn(() => resolve(mapped())),
    forgetNode: vi.fn(() => resolve(mapped())),
    resetNode: vi.fn(() => resolve(mapped())),
    resetNodeMapping: vi.fn(() => resolve(mapped())),
    previewNodeReset: vi.fn(() => resolve({ rows: [], nodeCount: 0, adopted: [] })),
    hideNode: vi.fn(() => resolve(mapped())),
    setSerialMonitor: vi.fn(() => resolve(undefined)),
    dumpSerialPorts: vi.fn(() => resolve({ path: '/tmp/serial-ports.txt', count: 0 })),
    revealDebugLog: vi.fn(() => resolve(undefined)),
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
    act(() => push('cal:data', snap)) // main's calRead pushes what it read
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

  const mock = Object.defineProperty(fns, 'scenario', { get: () => state }) as SkyhawkMock
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
          if (data !== undefined) push(ch, data as never)
        }
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
