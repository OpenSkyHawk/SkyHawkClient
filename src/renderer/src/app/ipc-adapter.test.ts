import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CALIBRATION_IDLE, type CalibrationState, type CalSnapshot } from '@shared/hid/calibration'
import {
  COCKPIT_IDLE,
  type NodeModel,
  type NodeSnapshot,
  type NodeTelemSnapshot
} from '@shared/nodes'
import type { PushChannel, PushChannels, RelayStatus } from '@shared/app'
import type { LogEvent } from '@shared/events'
import type { DeviceStatus, DeviceStatusPush } from '@shared/gateway'
import type { HidSnapshot } from '@shared/hid'
import { BACKUP_LIST_DEFAULT, DEFAULT_CONFIG, PSU_VIEW_DEFAULT } from '@shared/config'
import { AIRCRAFT_NONE, TELEMETRY_IDLE } from '@shared/dcs'
import { isLinkUp, LinkDownClock, linkFacts } from '../../../main/gateway/link-state'
import { relayFacts } from '../../../main/dcs/relay-rules'
import { hidFacts } from '../../../main/hid/hid-facts'

// The store talks to main through window.skyhawk. Only the calls initBridge() makes need to be
// real here; the rest exist so subscription setup does not throw.
type Listener = (data: unknown) => void
const listeners = new Map<string, Listener[]>()

/**
 * What main's pushes and its rehydrate bundle are built from, as the cases give them: since R3.3
 * main adds what it concludes (the link's facts) on the way out, as the fake below does with
 * main's own builders.
 */
interface Given {
  'device:status': DeviceStatus
  'hid:report': HidSnapshot
}
type GivenPushes = Omit<PushChannels, keyof Given> & Given
type GivenStatus = Omit<RelayStatus, 'device' | 'relayFacts' | 'aircraft' | 'telemetry'> &
  Partial<Pick<RelayStatus, 'aircraft' | 'telemetry'>> & { device: DeviceStatus }

/** Main's GatewayConnection: the page's "last known" time, judged per push (link-state.ts). */
let linkDown = new LinkDownClock()
const withFacts = (d: DeviceStatus): DeviceStatusPush => ({
  ...d,
  ...linkFacts(d, { linkDownAt: linkDown.value, serialMonitor: false })
})

let status: GivenStatus = {
  running: false,
  relay: { running: false },
  device: { state: 'no-device' }
}

const EMPTY_MODEL: NodeModel = {
  nodes: [],
  outages: [],
  differingCount: 0,
  hidden: [],
  hiddenNodes: [],
  rosterComplete: false
}
let nodesSnap: NodeSnapshot = { model: EMPTY_MODEL, telemetry: [] }
/** When set, `nodes:get` answers only once the test releases it (a reply racing a push). */
let nodesAnswer: Promise<NodeSnapshot> | undefined

let startResult: { ok: boolean; error?: string } = { ok: true }
let eventsSnap: LogEvent[] = []
let eventsCleared = 0

function fakeApi() {
  return {
    on: (ch: PushChannel, cb: Listener) => {
      listeners.set(ch, [...(listeners.get(ch) ?? []), cb])
      return () => {}
    },
    getStatus: () => {
      return Promise.resolve({
        // main's DcsRelay: the aircraft and the gauges as last pushed (none pushed by default)
        aircraft: AIRCRAFT_NONE,
        telemetry: TELEMETRY_IDLE,
        ...status,
        device: withFacts(status.device),
        // main's DcsRelay, over the default settings and this status
        relayFacts: relayFacts({
          config: DEFAULT_CONFIG,
          stream: status.relay.stream,
          deviceState: status.device.state,
          linkUp: isLinkUp(status.device.state),
          recording: { on: false }
        })
      })
    },
    getNodes: () => nodesAnswer ?? Promise.resolve(nodesSnap),
    getEvents: () => Promise.resolve(eventsSnap),
    clearEvents: () => {
      eventsCleared++
      return Promise.resolve()
    },
    // The settings and what they resolve to (`config:get` since R3.3).
    getConfig: () =>
      Promise.resolve({
        config: {
          sourceMode: 'bridge',
          transport: 'tcp-to-host',
          host: '127.0.0.1',
          commandPort: 7778,
          listenPort: 5010,
          autoConnect: true,
          replayDriveSerial: false,
          debugMode: false
        },
        psu: PSU_VIEW_DEFAULT
      }),
    // The automatic backups (`config:backups-get`, #136): none.
    getConfigBackups: () => Promise.resolve(BACKUP_LIST_DEFAULT),
    getHidAvailability: () => Promise.resolve({ axes: [0, 1], hats: [], buttons: [] }),
    setConfig: (patch: unknown) => Promise.resolve(patch),
    editConfig: (edit: unknown) => Promise.resolve(edit),
    // main's DcsRelay.toggle over the two intents below
    toggleRelay: (relaying: boolean) =>
      relaying
        ? Promise.resolve({ ok: true })
        : Promise.resolve({}).then(() => Promise.resolve(startResult)),
    startRelay: () => Promise.resolve(startResult),
    stopRelay: () => Promise.resolve({ ok: true })
  }
}

/** Deliver a main -> renderer push, as main builds it and the preload bridge delivers it. */
function push<C extends PushChannel>(ch: C, data: GivenPushes[C]) {
  let out: unknown = data
  if (ch === 'device:status') {
    const d = data as DeviceStatus
    linkDown.pushed(d.state)
    out = withFacts(d)
  }
  if (ch === 'hid:report') {
    const h = data as HidSnapshot
    out = { ...h, ...hidFacts(h.ageMs, undefined, [0, 1]) } // main's HidService, no device report
  }
  for (const cb of listeners.get(ch) ?? []) cb(out)
}

const snapshot = (calibratedMask: number, serial = 'BOARD-A'): CalSnapshot => ({
  presentMask: 0b11,
  calibratedMask,
  axes: Array.from({ length: 8 }, (_, idx) => ({
    idx,
    controlId: idx < 2 ? 0x10 + idx : 0,
    min: 0,
    centre: 0,
    max: 0,
    deadzone: 0,
    present: idx < 2,
    calibrated: (calibratedMask & (1 << idx)) !== 0
  })),
  serialNumber: serial
})

/** What main pushes on `cal:workflow` with `snap` reported (only the snapshot matters here). */
const calibration = (snap: CalSnapshot): CalibrationState => ({
  tab: { ...CALIBRATION_IDLE.tab, snapshot: snap }
})

/**
 * A fresh module instance per test.
 *
 * The IPC adapter guards against duplicate IPC subscriptions with a module-level flag, so reusing
 * the import would make initBridge() a no-op after the first test — and a reload is exactly what is
 * under test here.
 *
 * Since R3.4b the renderer's state is split across the topic stores; the cases read it as one, the
 * way the single store held it (the Log tab's Pause is the events slice's `togglePause`).
 */
async function freshStore(mainClock?: LinkDownClock) {
  listeners.clear()
  // Main's clock has judged the link's state it already pushed, before this page loaded; a reload
  // of a page main kept serving hands its own clock on.
  if (mainClock) linkDown = mainClock
  else {
    linkDown = new LinkDownClock()
    linkDown.pushed(status.device.state)
  }
  vi.resetModules()
  ;(globalThis as { window?: unknown }).window = { skyhawk: fakeApi() }
  const { initBridge } = await import('./ipc-adapter')
  const { useNav } = await import('./kit')
  const { useGatewayStore } = await import('../gateway')
  const { useDcsStore } = await import('../dcs')
  const { useNodesStore } = await import('../nodes')
  const { useHidStore } = await import('../hid')
  const { useCalibrationStore } = await import('../hid/calibration')
  const { useEventsStore } = await import('../events')
  const { useConfigStore } = await import('../config')
  await initBridge()
  await Promise.resolve()
  await Promise.resolve()
  const toggle = (key: 'logPaused' | 'autoscroll' | 'rawMode') =>
    key === 'logPaused'
      ? useEventsStore.getState().togglePause()
      : useDcsStore.getState().toggle(key)
  return {
    getState: () => ({
      ...useNav.getState(),
      ...useGatewayStore.getState(),
      ...useDcsStore.getState(),
      ...useNodesStore.getState(),
      ...useHidStore.getState(),
      ...useCalibrationStore.getState(),
      ...useEventsStore.getState(),
      ...useConfigStore.getState(),
      toggle
    })
  }
}

describe('calibration state lifecycle', () => {
  beforeEach(() => {
    status = { running: false, relay: { running: false }, device: { state: 'no-device' } }
  })

  // The report itself — taken from GET_CAL, dropped whenever the link is not up — is main's since
  // R3.1 (main/hid/calibration/workflow-host.test.ts). The store holds what main pushes.
  it('starts with no snapshot, which is not the same as uncalibrated', async () => {
    const s = await freshStore()
    expect(s.getState().calibration.tab.snapshot).toBeUndefined()
  })

  it('takes the snapshot from a cal:workflow push', async () => {
    const s = await freshStore()
    push('cal:workflow', calibration(snapshot(0b01)))
    expect(s.getState().calibration.tab.snapshot?.calibratedMask).toBe(0b01)
  })

  it('rehydrates the snapshot on a renderer reload', async () => {
    // The regression: a reload builds a fresh store while the main-process session keeps
    // running. No port-open event follows, so no GET_CAL is read, and without the snapshot
    // in session status the badges would stay blank indefinitely on a stable link.
    status = {
      running: true,
      relay: { running: true, stream: 'connected' },
      device: { state: 'connected', portPath: '/dev/fake' },
      cal: calibration(snapshot(0b01))
    }
    const s = await freshStore()
    expect(
      s.getState().calibration.tab.snapshot?.calibratedMask,
      'reload must recover the badges'
    ).toBe(0b01)
    expect(s.getState().deviceState).toBe('connected')
  })

  it('rehydrates nothing when the link is down', async () => {
    status = { running: false, relay: { running: false }, device: { state: 'no-device' } }
    const s = await freshStore()
    expect(s.getState().calibration.tab.snapshot).toBeUndefined()
  })
})

describe('relay state (#69)', () => {
  beforeEach(() => {
    status = { running: false, relay: { running: false }, device: { state: 'no-device' } }
  })

  it('follows relay:state, separately from the device', async () => {
    const s = await freshStore()
    push('relay:state', { running: true, stream: 'reconnecting' })
    expect(s.getState().relaying).toBe(true)
    push('device:status', { state: 'connected', portPath: '/dev/fake' })
    push('relay:state', { running: false })
    expect(s.getState().relaying).toBe(false)
    expect(s.getState().deviceState, 'stopping the relay leaves the link up').toBe('connected')
  })

  it('rehydrates what main still shows on a reload: the aircraft, the gauges, the link (N1)', async () => {
    const aircraft = { name: 'A-4E-C', supported: true }
    const telemetry = TELEMETRY_IDLE.map((g) => ({ ...g, value: 42, pct: 0.42 }))
    status = { running: false, relay: { running: false }, device: { state: 'connected' } }
    const before = await freshStore()
    push('device:status', { state: 'no-device' })
    const at = before.getState().linkDownAt
    expect(at).toBeDefined()
    status = { ...status, device: { state: 'no-device' }, aircraft, telemetry }
    const s = await freshStore(linkDown)
    expect(s.getState().aircraft).toEqual(aircraft)
    expect(s.getState().telemetry).toEqual(telemetry)
    expect(s.getState().linkDownAt, 'the last-known time main holds').toBe(at)
  })

  it('rehydrates the relay state on a reload', async () => {
    status = {
      running: true,
      relay: { running: true, stream: 'connected' },
      device: { state: 'connected', portPath: '/dev/fake' }
    }
    const s = await freshStore()
    expect(s.getState().relaying).toBe(true)
  })
})

describe('starting the relay (#69)', () => {
  beforeEach(() => {
    status = { running: false, relay: { running: false }, device: { state: 'no-device' } }
  })

  it('takes back the optimistic Relaying when main refuses the Start', async () => {
    startResult = { ok: false, error: 'SimGateway is not connected' }
    const s = await freshStore()
    s.getState().toggleRelay()
    expect(s.getState().relaying, 'optimistic until main answers').toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(s.getState().relaying).toBe(false)
    startResult = { ok: true }
  })

  it('keeps Relaying when main accepts', async () => {
    startResult = { ok: true }
    const s = await freshStore()
    s.getState().toggleRelay()
    await new Promise((r) => setTimeout(r, 0))
    expect(s.getState().relaying).toBe(true)
  })
})

describe('node state (#63)', () => {
  const pduModel: NodeModel = {
    ...EMPTY_MODEL,
    rosterComplete: true,
    nodes: [
      {
        nodeId: 3,
        name: 'PDU_Left',
        console: 'Left',
        pduId: null,
        kind: 'pdu',
        source: 'registry',
        availability: 'online',
        readings: 'live',
        differs: false
      }
    ]
  }
  const telem = (i12Ma: number): NodeTelemSnapshot[] => [
    {
      nodeId: 3,
      isPdu: true,
      rail12V: {
        kind: 'rail',
        page: 1,
        flags: 0,
        vAvgMv: 12_000,
        vMinMv: 11_900,
        iAvgMa: i12Ma,
        ageMs: 0,
        stale: false
      },
      other: [],
      live: true
    }
  ]

  beforeEach(() => {
    status = { running: false, relay: { running: false }, device: { state: 'connected' } }
    nodesSnap = { model: EMPTY_MODEL, telemetry: [] }
    nodesAnswer = undefined
  })

  it('rehydrates the model on a renderer reload', async () => {
    nodesSnap = { model: pduModel, telemetry: telem(1000) }
    const s = await freshStore()
    expect(s.getState().nodeModel).toBe(pduModel)
  })

  it('keeps the last model when the link drops, and remembers when it dropped', async () => {
    const s = await freshStore()
    push('nodes:model', pduModel)
    expect(s.getState().linkDownAt).toBeUndefined()
    push('device:status', { state: 'reconnecting' })
    expect(s.getState().nodeModel).toBe(pduModel)
    const at = s.getState().linkDownAt
    expect(at).toBeDefined()
    push('device:status', { state: 'no-device' })
    expect(s.getState().linkDownAt, 'only the up → down transition sets it').toBe(at)
    push('device:status', { state: 'connected' })
    expect(s.getState().linkDownAt).toBeUndefined()
  })

  it('an older model never wins: a pull answered behind a newer push is dropped (C5)', async () => {
    let answer!: (snap: NodeSnapshot) => void
    nodesAnswer = new Promise((r) => (answer = r))
    const s = await freshStore()
    const newer = { ...pduModel, rev: 5 }
    push('nodes:model', newer)
    answer({ model: { ...EMPTY_MODEL, rev: 4 }, telemetry: [] })
    await nodesAnswer
    await Promise.resolve()
    expect(s.getState().nodeModel).toBe(newer)
    // A pull as new as the last push (or newer) is taken, and so is every newer push.
    const pushed = { ...EMPTY_MODEL, rev: 6 }
    push('nodes:model', pushed)
    expect(s.getState().nodeModel).toBe(pushed)
    push('nodes:model', { ...pduModel, rev: 5 })
    expect(s.getState().nodeModel).toBe(pushed)
  })

  it('an older Cockpit snapshot never wins (C5)', async () => {
    const s = await freshStore()
    const newer = { ...COCKPIT_IDLE, rev: 8, live: true }
    push('cockpit:snapshot', newer)
    push('cockpit:snapshot', { ...COCKPIT_IDLE, rev: 7 })
    expect(s.getState().cockpit).toBe(newer)
    const next = { ...COCKPIT_IDLE, rev: 9 }
    push('cockpit:snapshot', next)
    expect(s.getState().cockpit).toBe(next)
  })
})

describe('event log (#64)', () => {
  const ev = (id: number): LogEvent => ({
    id,
    t: id,
    source: 'node',
    name: 'PDU_Right',
    severity: 'warn',
    event: '5V UNDER-V raised',
    raw: ''
  })

  beforeEach(() => {
    status = { running: false, relay: { running: false }, device: { state: 'no-device' } }
    eventsSnap = []
    eventsCleared = 0
  })

  it('rehydrates the session events on a renderer reload, newest first', async () => {
    eventsSnap = [ev(1), ev(2)]
    const s = await freshStore()
    expect(s.getState().events.map((e) => e.id)).toEqual([2, 1])
  })

  it('adds pushed events newest first', async () => {
    const s = await freshStore()
    push('events:batch', [ev(1), ev(2)])
    push('events:batch', [ev(3)])
    expect(s.getState().events.map((e) => e.id)).toEqual([3, 2, 1])
  })

  it('keeps recording while paused; the pause mark holds the view', async () => {
    const s = await freshStore()
    push('events:batch', [ev(1)])
    s.getState().toggle('logPaused')
    push('events:batch', [ev(2)])
    expect(s.getState().events).toHaveLength(2)
    expect(s.getState().eventsPauseMark).toBe(1)
    s.getState().toggle('logPaused')
    expect(s.getState().eventsPauseMark).toBeUndefined()
  })

  it('Clear empties the list here and in main', async () => {
    const s = await freshStore()
    push('events:batch', [ev(1)])
    s.getState().clearEvents()
    expect(s.getState().events).toEqual([])
    expect(eventsCleared).toBe(1)
  })

  it('showEvents opens Log › Events with a source filter', async () => {
    const s = await freshStore()
    s.getState().showEvents('node')
    expect(s.getState()).toMatchObject({ tab: 'log', logView: 'events', eventSource: 'node' })
  })
})
