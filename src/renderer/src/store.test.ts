import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalSnapshot, NodeSnapshot, PushChannel, PushChannels, RelayStatus } from '@shared/ipc'
import type { NodeModel } from '@shared/node-rules'
import type { NodeTelemSnapshot } from '@shared/node-telem'
import type { LogEvent } from '@shared/events'

// The store talks to main through window.skyhawk. Only the calls initBridge() makes need to be
// real here; the rest exist so subscription setup does not throw.
type Listener = (data: unknown) => void
const listeners = new Map<string, Listener[]>()
let status: RelayStatus = {
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

let startResult: { ok: boolean; error?: string } = { ok: true }
let eventsSnap: LogEvent[] = []
let eventsCleared = 0

function fakeApi() {
  return {
    on: (ch: PushChannel, cb: Listener) => {
      listeners.set(ch, [...(listeners.get(ch) ?? []), cb])
      return () => {}
    },
    getStatus: () => Promise.resolve(status),
    getNodes: () => Promise.resolve(nodesSnap),
    getEvents: () => Promise.resolve(eventsSnap),
    clearEvents: () => {
      eventsCleared++
      return Promise.resolve()
    },
    getConfig: () =>
      Promise.resolve({
        sourceMode: 'bridge',
        transport: 'tcp-to-host',
        host: '127.0.0.1',
        commandPort: 7778,
        listenPort: 5010,
        autoConnect: true,
        replayDriveSerial: false,
        debugMode: false
      }),
    getHidAvailability: () => Promise.resolve({ axes: [0, 1], hats: [], buttons: [] }),
    setConfig: (patch: unknown) => Promise.resolve(patch),
    startRelay: () => Promise.resolve(startResult),
    stopRelay: () => Promise.resolve({ ok: true })
  }
}

/** Deliver a main -> renderer push, as the preload bridge would. */
function push<C extends PushChannel>(ch: C, data: PushChannels[C]) {
  for (const cb of listeners.get(ch) ?? []) cb(data)
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

/**
 * A fresh module instance per test.
 *
 * store.ts guards against duplicate IPC subscriptions with a module-level flag, so reusing the
 * import would make initBridge() a no-op after the first test — and a reload is exactly what is
 * under test here.
 */
async function freshStore() {
  listeners.clear()
  vi.resetModules()
  ;(globalThis as { window?: unknown }).window = { skyhawk: fakeApi() }
  const mod = await import('./store')
  const { useStore } = mod
  await useStore.getState().initBridge()
  await Promise.resolve()
  await Promise.resolve()
  return useStore
}

describe('calibration state lifecycle', () => {
  beforeEach(() => {
    status = { running: false, relay: { running: false }, device: { state: 'no-device' } }
  })

  it('starts with no snapshot, which is not the same as uncalibrated', async () => {
    const s = await freshStore()
    expect(s.getState().cal).toBeUndefined()
  })

  it('takes the snapshot from a cal:data push', async () => {
    const s = await freshStore()
    push('cal:data', snapshot(0b01))
    expect(s.getState().cal?.calibratedMask).toBe(0b01)
  })

  it('carries the report age, not just the rate', async () => {
    // HidReader has always computed ageMs, and the store used to take only rateHz — so the
    // freshness signal existed in main and was dropped at the IPC boundary.
    const s = await freshStore()
    push('hid:report', { axes: [1], buttons: [false], hats: [0], ageMs: 90_000, rateHz: 3 })
    expect(s.getState().hidRate).toBe(3)
    expect(s.getState().hidAgeMs).toBe(90_000)
  })

  it('rehydrates the snapshot on a renderer reload', async () => {
    // The regression: a reload builds a fresh store while the main-process session keeps
    // running. No port-open event follows, so no cal:data is pushed, and without the snapshot
    // in session status the badges would stay blank indefinitely on a stable link.
    status = {
      running: true,
      relay: { running: true, stream: 'connected' },
      device: { state: 'connected', portPath: '/dev/fake' },
      cal: snapshot(0b01)
    }
    const s = await freshStore()
    expect(s.getState().cal?.calibratedMask, 'reload must recover the badges').toBe(0b01)
    expect(s.getState().deviceState).toBe('connected')
  })

  it('rehydrates nothing when the link is down', async () => {
    status = { running: false, relay: { running: false }, device: { state: 'no-device' } }
    const s = await freshStore()
    expect(s.getState().cal).toBeUndefined()
  })

  // Clearing only on `no-device` would leave the previous board's badges on screen through a
  // reconnect -- and permanently, if the next board runs firmware that never sends cal:data.
  for (const state of ['reconnecting', 'error', 'no-device', 'scanning', 'disconnected'] as const) {
    it(`drops the snapshot when the device goes ${state}`, async () => {
      const s = await freshStore()
      push('cal:data', snapshot(0b01))
      expect(s.getState().cal).toBeDefined()
      push('device:status', { state })
      expect(s.getState().cal, `${state} means the snapshot cannot be vouched for`).toBeUndefined()
    })
  }

  it('keeps the snapshot while the link stays up', async () => {
    const s = await freshStore()
    push('cal:data', snapshot(0b01))
    push('device:status', { state: 'connected', portPath: '/dev/fake' })
    expect(s.getState().cal?.calibratedMask).toBe(0b01)
  })

  it('replaces one board’s snapshot with the next board’s, never merging them', async () => {
    const s = await freshStore()
    push('cal:data', snapshot(0b11, 'BOARD-A'))
    push('device:status', { state: 'reconnecting' })
    expect(s.getState().cal).toBeUndefined()
    push('device:status', { state: 'connected' })
    push('cal:data', snapshot(0b00, 'BOARD-B'))
    expect(s.getState().cal?.serialNumber).toBe('BOARD-B')
    expect(s.getState().cal?.calibratedMask).toBe(0b00)
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
    expect(s.getState().relayStream).toBe('reconnecting')
    push('device:status', { state: 'connected', portPath: '/dev/fake' })
    push('relay:state', { running: false })
    expect(s.getState().relaying).toBe(false)
    expect(s.getState().relayStream).toBeUndefined()
    expect(s.getState().deviceState, 'stopping the relay leaves the link up').toBe('connected')
  })

  it('rehydrates the stream state on a reload', async () => {
    status = {
      running: true,
      relay: { running: true, stream: 'connected' },
      device: { state: 'connected', portPath: '/dev/fake' }
    }
    const s = await freshStore()
    expect(s.getState().relaying).toBe(true)
    expect(s.getState().relayStream).toBe('connected')
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
  })

  it('rehydrates the model and telemetry on a renderer reload', async () => {
    nodesSnap = { model: pduModel, telemetry: telem(1000) }
    const s = await freshStore()
    expect(s.getState().nodeModel).toBe(pduModel)
    expect(s.getState().nodeTelemetry).toHaveLength(1)
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

  it('tracks the session peak of the computed total power', async () => {
    const s = await freshStore()
    push('nodes:model', pduModel)
    push('nodes:telemetry', telem(2000))
    expect(s.getState().nodesPeakW).toBeCloseTo(24)
    push('nodes:telemetry', telem(1000))
    expect(s.getState().nodesPeakW).toBeCloseTo(24)
  })

  it('peaks over the same PDUs as the Total card: an unadopted PDU does not count', async () => {
    // Review of #80: one registry PDU and one still in "New on the bus", 29 W each, read
    // "Total 29.0 W · peak 58.0 W" — a peak the card could never show.
    const withNew: NodeModel = {
      ...pduModel,
      nodes: [
        ...pduModel.nodes,
        { ...pduModel.nodes[0]!, nodeId: 42, name: 'Node 42', console: null, source: 'new' }
      ]
    }
    const s = await freshStore()
    push('nodes:model', withNew)
    push('nodes:telemetry', [...telem(2417), { ...telem(2417)[0]!, nodeId: 42 }])
    expect(s.getState().nodesPeakW).toBeCloseTo(29, 0)
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
