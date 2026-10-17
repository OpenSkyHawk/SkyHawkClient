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
//     `nodes:telemetry`, `events:batch`, `cal:data`, `hid:report`, `aircraft:changed`.
// Tests never set renderer store fields and never push channels by hand, so they assert what the
// user sees for a given main-side situation — not how the renderer stores it.
//
// When the rewrite moves a decision into main and adds a push for it (R3: `cockpit:snapshot`,
// `cal:workflow`, …), main gets a pure builder for that push. `emitScenario` then derives the new
// push by calling that builder on the same scenario inputs and sends it alongside (or instead of)
// today's channels. The change stays inside this file: every component test keeps its scenarios
// and its assertions unchanged.
//
// Intents (renderer → main requests) are `vi.fn`s with harmless defaults, so a test can assert the
// call (`expect(sky.forgetNode).toHaveBeenCalledWith(4)`) or override the answer
// (`sky.forgetNode.mockResolvedValueOnce({ ok: false, error: '…' })`). The type follows
// `SkyhawkApi`, so an IPC change breaks the mock at typecheck, not at run time.
import { act } from '@testing-library/react'
import { vi, type Mock } from 'vitest'
import { DEFAULT_CONFIG, type AppConfig } from '@shared/config/ipc'
import type { AircraftStatus, RelayState } from '@shared/dcs/ipc'
import type { CalSnapshot } from '@shared/hid/calibration/ipc'
import type { DeviceStatus } from '@shared/gateway/ipc'
import type { HidSnapshot } from '@shared/hid/ipc'
import type { NodeModel, NodeRegistryInfo, NodeTelemSnapshot } from '@shared/nodes/ipc'
import type { PushChannel, PushChannels, SkyhawkApi } from '@shared/app/ipc'
import type { LogEvent } from '@shared/events/ipc'

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
  /** The bundled NODE_IDS.md (`getNodeRegistry`; never pushed). */
  registry?: NodeRegistryInfo
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
  model: 'nodes:model',
  telemetry: 'nodes:telemetry',
  events: 'events:batch',
  cal: 'cal:data',
  hid: 'hid:report'
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
    getHidAvailability: vi.fn(() => resolve({ axes: [], hats: [], buttons: [] })),

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
    calHello: vi.fn(() => resolve(calFail)),
    calRead: vi.fn(() => resolve(calFail)),
    calSessionOpen: vi.fn(() => resolve(calFail)),
    calStreamSelect: vi.fn(() => resolve(calFail)),
    calCommit: vi.fn(() => resolve(calFail)),
    calReset: vi.fn(() => resolve(calFail)),
    calSessionClose: vi.fn(() => resolve({ ok: true as const, value: null })),
    calCacheRead: vi.fn(() => resolve({ ok: true as const, value: { regressed: [] } })),
    calCacheStore: vi.fn(() => resolve({ ok: true as const, value: null })),
    calCacheDrop: vi.fn(() => resolve({ ok: true as const, value: null }))
  }

  /** A mapping intent main accepted: it answers with the model (and would push it). */
  const mapped = () => ({ ok: true as const, model: state.model ?? EMPTY_MODEL })

  const push = <C extends PushChannel>(ch: C, data: PushChannels[C]): void => {
    for (const cb of listeners.get(ch) ?? []) (cb as (d: PushChannels[C]) => void)(data)
  }

  const mock = Object.defineProperty(fns, 'scenario', { get: () => state }) as SkyhawkMock
  Object.assign(mock, {
    emitScenario(s: Scenario) {
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
