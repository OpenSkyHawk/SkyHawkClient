// The Cockpit snapshot host (R3.2): the peak W the renderer's store tracked (its two store test
// cases, ported with the same pushes and expected values), when it pushes, and the stray timer the
// Cockpit tab ran (nextAt + 50 ms).
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COCKPIT_IDLE,
  type CockpitSnapshot,
  type NodeModel,
  type NodeTelemSnapshot
} from '@shared/nodes'
import type { DeviceStatus } from '@shared/gateway'
import { modelNode, nodeModel } from '../../test-fixtures/nodes'
import { CockpitSnapshotHost, STRAY_RECHECK_MS } from './cockpit-host'
import { buildCockpitSnapshot } from './cockpit-snapshot'
import { IDENTIFY_WAIT_MS } from './cockpit-snapshot/attention'

const EMPTY_MODEL: NodeModel = {
  nodes: [],
  outages: [],
  differingCount: 0,
  hidden: [],
  hiddenNodes: [],
  rosterComplete: false
}

function rig(device: DeviceStatus = { state: 'connected' }) {
  const pushed: CockpitSnapshot[] = []
  const link = { device }
  const host = new CockpitSnapshotHost((s) => pushed.push(s), { device: () => link.device })
  return { host, pushed, link }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('node state (#63) — the peak W, from the store', () => {
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

  it('tracks the session peak of the computed total power', () => {
    const { host } = rig()
    host.modelPushed(pduModel)
    host.telemetryPushed(telem(2000))
    expect(host.state().band.peakW).toBeCloseTo(24)
    host.telemetryPushed(telem(1000))
    expect(host.state().band.peakW).toBeCloseTo(24)
  })

  it('peaks over the same PDUs as the Total card: an unadopted PDU does not count', () => {
    // Review of #80: one registry PDU and one still in "New on the bus", 29 W each, read
    // "Total 29.0 W · peak 58.0 W" — a peak the card could never show.
    const withNew: NodeModel = {
      ...pduModel,
      nodes: [
        ...pduModel.nodes,
        { ...pduModel.nodes[0]!, nodeId: 42, name: 'Node 42', console: null, source: 'new' }
      ]
    }
    const { host } = rig()
    host.modelPushed(withNew)
    host.telemetryPushed([...telem(2417), { ...telem(2417)[0]!, nodeId: 42 }])
    expect(host.state().band.peakW).toBeCloseTo(29, 0)
  })

  it('a renderer reload starts the peak over from what main holds now', () => {
    const { host } = rig()
    host.modelPushed(pduModel)
    host.telemetryPushed(telem(2000))
    host.rendererLoaded(pduModel, telem(1000))
    expect(host.state().band.peakW).toBeCloseTo(12)
  })
})

describe('CockpitSnapshotHost', () => {
  it('starts idle: the launch state equals what the builder makes of no model', () => {
    const { host, pushed } = rig({ state: 'no-device' })
    expect(host.state()).toBe(COCKPIT_IDLE)
    expect(pushed).toEqual([])
    const built = buildCockpitSnapshot({
      telemetry: [],
      device: { state: 'no-device' },
      peakW: 0,
      now: 0,
      rev: 0
    })
    expect(built).toEqual({ snapshot: COCKPIT_IDLE })
  })

  it('pushes after each model, telemetry, link change and renderer load, with a rising rev', () => {
    const { host, pushed, link } = rig({ state: 'no-device' })
    host.modelPushed(nodeModel([modelNode(1)]))
    host.telemetryPushed([])
    link.device = { state: 'connected' }
    host.linkChanged()
    host.rendererLoaded(nodeModel([modelNode(1)]), [])
    expect(pushed.map((s) => [s.rev, s.live, s.views.length])).toEqual([
      [1, false, 1],
      [2, false, 1],
      [3, true, 1],
      [4, true, 1]
    ])
    expect(host.state()).toBe(pushed[3])
  })

  it('lists the registry its source answers with, in Settings’ rows (R3.2b)', () => {
    const pushed: CockpitSnapshot[] = []
    const registry = {
      file: 'Firmware/NODE_IDS.md',
      commit: 'abc1234',
      date: '2026-10-01',
      nodes: [{ nodeId: 1, name: 'Center_Armament', console: 'Center', kind: 'panel' as const }]
    }
    const host = new CockpitSnapshotHost((s) => pushed.push(s), {
      device: () => ({ state: 'connected' }),
      registry: () => registry
    })
    host.modelPushed(nodeModel([modelNode(1)]))
    expect(pushed[0]!.settings.registry).toEqual({
      summary: 'NODE_IDS.md · 1 node: 0 PDUs, 1 panel group',
      rows: [
        {
          nodeId: 1,
          name: 'Center_Armament',
          console: 'Center',
          onBus: { text: 'yes', dot: 'on' },
          unloaded: { text: '—', dot: '' }
        }
      ]
    })
  })

  it('a board still identifying: rebuilt nextAt + 50 ms later, when it becomes a stray', () => {
    vi.useFakeTimers({ now: 10_000 })
    const { host, pushed } = rig()
    const fresh = modelNode(9, { source: 'new', console: null, firstSeenAt: 10_000 })
    host.modelPushed(nodeModel([fresh]))
    expect(pushed.at(-1)!.attention.items).toEqual([])
    const due = 10_000 + IDENTIFY_WAIT_MS + STRAY_RECHECK_MS
    vi.advanceTimersByTime(due - 10_000 - 1)
    expect(pushed).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(pushed).toHaveLength(2)
    expect(Date.now()).toBe(due)
    expect(pushed[1]!.attention.items.map((i) => i.flag)).toEqual([
      'UNIDENTIFIED · can’t be adopted'
    ])
    // Nothing left identifying: no timer.
    vi.advanceTimersByTime(60_000)
    expect(pushed).toHaveLength(2)
  })

  it('keeps one timer per nextAt, as the renderer effect did, and drops it once nothing waits', () => {
    vi.useFakeTimers({ now: 0 })
    const { host, pushed } = rig()
    const a = modelNode(9, { source: 'new', console: null, firstSeenAt: 0 })
    host.modelPushed(nodeModel([a]))
    host.telemetryPushed([]) // same nextAt: the timer stays
    vi.advanceTimersByTime(2000)
    host.modelPushed(nodeModel([{ ...a, identified: 'panel' }])) // adoptable now: nothing waits
    vi.advanceTimersByTime(10_000)
    expect(pushed).toHaveLength(3)
    host.dispose()
  })
})

describe('CockpitSnapshotHost — the strays’ clock', () => {
  it('a push inside the 50 ms after a board is due is judged at the old time, as the tab was', () => {
    vi.useFakeTimers({ now: 0 })
    const { host, pushed } = rig()
    const a = modelNode(9, { source: 'new', console: null, firstSeenAt: 0 })
    host.modelPushed(nodeModel([a]))
    vi.advanceTimersByTime(IDENTIFY_WAIT_MS + 20)
    host.telemetryPushed([])
    expect(pushed.at(-1)!.attention.items).toEqual([])
    vi.advanceTimersByTime(STRAY_RECHECK_MS - 20)
    expect(pushed.at(-1)!.attention.items.map((i) => i.nodeId)).toEqual([9])
    host.dispose()
  })
})
