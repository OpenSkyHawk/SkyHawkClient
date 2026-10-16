import { describe, expect, it } from 'vitest'
import {
  buildNodeModel,
  cameOnline,
  isReportableNew,
  PDU_GROUP_POLL_CATCH_MS,
  PDU_GROUP_WINDOW_MS,
  type NodeModelInput
} from './node-rules'
import { EMPTY_MAPPING, registryDefaults, type NodeMappingFile } from './node-mapping'
import type { NodeSeen, NodeStatus } from './nodes'
import type { NodeTelemSnapshot } from './node-telem'

const defaults = registryDefaults({
  0: { name: 'PanelBridge', console: '—' },
  1: { name: 'Center_Armament', console: 'Center' },
  2: { name: 'Right_Navigation', console: 'Right' },
  3: { name: 'PDU_Left', console: 'Left' },
  4: { name: 'PDU_Right', console: 'Right' },
  5: { name: 'PDU_Center', console: 'Center' }
})

const st = (nodeId: number, present = true): NodeStatus => ({
  nodeId,
  present,
  boff: false,
  epvf: false,
  uptimeSec: 0,
  rxCount: 0,
  tec: 0,
  rec: 0,
  dieTempC: null,
  overheat: false,
  degraded: false,
  faultId: 0,
  nodeKind: 0
})
/** A PDU with a fresh 12 V page; pass `stale: true` for one whose pages all went stale. */
const telem = (
  nodeId: number,
  over: Partial<NodeTelemSnapshot> & { stale?: boolean } = {}
): NodeTelemSnapshot => {
  const { stale = false, ...rest } = over
  return {
    nodeId,
    isPdu: true,
    rail12V: {
      kind: 'rail',
      page: 1,
      flags: 0,
      vAvgMv: 12000,
      vMinMv: 11900,
      iAvgMa: 500,
      ageMs: stale ? 20_000 : 0,
      stale
    },
    other: [],
    live: !stale,
    ...rest
  }
}

const input = (over: Partial<NodeModelInput>): NodeModelInput => ({
  roster: [],
  seen: new Map(),
  telemetry: [],
  defaults,
  file: EMPTY_MAPPING,
  ...over
})
const entry = (i: NodeModelInput, id: number) =>
  buildNodeModel(i).nodes.find((n) => n.nodeId === id)

describe('availability', () => {
  it('registry nodes are unknown until the first complete roster, then offline if missing', () => {
    expect(entry(input({}), 1)?.availability).toBe('unknown')
    const after = input({ roster: [st(2)], rosterCompleteAt: 500 })
    expect(entry(after, 1)).toMatchObject({
      availability: 'offline',
      offlineAt: 500,
      offlineVia: 'roster'
    })
    expect(entry(after, 2)?.availability).toBe('online')
  })

  it('a node reported absent is offline with its own timing', () => {
    const seen = new Map<number, NodeSeen>([
      [1, { firstSeenAt: 0, offlineAt: 900, offlineVia: 'delta' }]
    ])
    expect(entry(input({ roster: [st(1, false)], seen }), 1)).toMatchObject({
      availability: 'offline',
      offlineAt: 900,
      offlineVia: 'delta'
    })
  })

  it('hidden nodes are skipped (not offline), ignored nodes are left out entirely', () => {
    const file: NodeMappingFile = { version: 1, nodes: { 2: { hidden: true } }, ignored: [1] }
    const m = buildNodeModel(input({ file, rosterCompleteAt: 0 }))
    expect(m.nodes.map((n) => n.nodeId)).toEqual([3, 4, 5])
    expect(m.hidden).toEqual([2])
    expect(m.ignored).toEqual([1])
  })

  // Review of #85: Settings › Hidden nodes showed registry names, not what the Cockpit showed.
  it('lists each hidden node with the name and console the Cockpit showed', () => {
    const file: NodeMappingFile = {
      version: 1,
      nodes: {
        2: { hidden: true, name: 'Nav_Repeater', console: 'Left' },
        41: { hidden: true, name: 'Left_Lights', console: 'Left', kind: 'panel', pduId: 3 }
      },
      ignored: []
    }
    const m = buildNodeModel(input({ file, rosterCompleteAt: 0 }))
    expect(m.hidden).toEqual([2, 41])
    expect(m.hiddenNodes).toEqual([
      { nodeId: 2, name: 'Nav_Repeater', console: 'Left' },
      { nodeId: 41, name: 'Left_Lights', console: 'Left' }
    ])
  })

  it('a hidden registry node with no overrides keeps its registry name', () => {
    const file: NodeMappingFile = { version: 1, nodes: { 2: { hidden: true } }, ignored: [] }
    expect(buildNodeModel(input({ file })).hiddenNodes).toEqual([
      { nodeId: 2, name: 'Right_Navigation', console: 'Right' }
    ])
  })
})

describe('new-node detection', () => {
  it('a roster node outside the registry and mapping is new, with first-seen; PDU by its pages', () => {
    const seen = new Map<number, NodeSeen>([
      [41, { firstSeenAt: 1234 }],
      [42, { firstSeenAt: 1300 }]
    ])
    const i = input({ roster: [st(41), st(42)], seen, telemetry: [telem(42)] })
    expect(entry(i, 41)).toMatchObject({
      source: 'new',
      kind: 'panel',
      name: 'Node 41',
      console: null,
      firstSeenAt: 1234
    })
    expect(entry(i, 42)).toMatchObject({ source: 'new', kind: 'pdu', readings: 'live' })
  })

  it('registry, adopted and ignored ids are never new', () => {
    const file: NodeMappingFile = {
      version: 1,
      nodes: { 41: { name: 'Trim', console: 'Left', pduId: 3, kind: 'panel' } },
      ignored: [42]
    }
    const m = buildNodeModel(input({ roster: [st(1), st(41), st(42)], file }))
    expect(m.nodes.filter((n) => n.source === 'new')).toEqual([])
    const adopted = m.nodes.find((n) => n.nodeId === 41)
    expect(adopted).toMatchObject({ source: 'adopted', name: 'Trim' })
    expect(adopted?.firstSeenAt).toBeUndefined()
  })
})

describe('PDU readings', () => {
  it('online PDU with fresh telemetry is live; stale or none is "none"', () => {
    expect(entry(input({ roster: [st(3)], telemetry: [telem(3)] }), 3)).toMatchObject({
      readings: 'live',
      everHadReadings: true
    })
    expect(
      entry(input({ roster: [st(3)], telemetry: [telem(3, { stale: true })] }), 3)
    ).toMatchObject({
      readings: 'none',
      everHadReadings: true
    })
    expect(entry(input({ roster: [st(3)] }), 3)).toMatchObject({
      readings: 'none',
      everHadReadings: false
    })
  })

  it('a fresh page of an unknown type does not count as PDU readings', () => {
    const rail = { kind: 'rail', page: 1, flags: 0, vAvgMv: 0, vMinMv: 0, iAvgMa: 0 } as const
    const t = telem(3, {
      live: true,
      rail12V: { ...rail, ageMs: 20_000, stale: true },
      other: [{ kind: 'unknown', page: 0x7f, body: '', ageMs: 0, stale: false }]
    })
    expect(entry(input({ roster: [st(3)], telemetry: [t] }), 3)?.readings).toBe('none')
  })

  it('offline PDUs and panels carry no readings state', () => {
    expect(entry(input({ roster: [st(3, false)] }), 3)?.readings).toBeUndefined()
    expect(entry(input({ roster: [st(1)] }), 1)?.everHadReadings).toBeUndefined()
  })
})

describe('PDU-offline grouping', () => {
  // PDU_Left (3) feeds 41, 42, 43.
  const file: NodeMappingFile = {
    version: 1,
    nodes: {
      41: { name: 'A', console: 'Left', pduId: 3, kind: 'panel' },
      42: { name: 'B', console: 'Left', pduId: 3, kind: 'panel' },
      43: { name: 'C', console: 'Left', pduId: 3, kind: 'panel' }
    },
    ignored: []
  }
  /** Was online, then dropped. */
  const off = (at: number, via: 'delta' | 'roster' = 'delta'): NodeSeen => ({
    firstSeenAt: 0,
    everPresent: true,
    offlineAt: at,
    offlineVia: via
  })
  const model = (seen: [number, NodeSeen][], onlineIds: number[] = []) =>
    buildNodeModel(
      input({
        file,
        roster: [...seen.map(([id]) => st(id, false)), ...onlineIds.map((id) => st(id))],
        seen: new Map(seen)
      })
    )

  it('PDU plus most of its nodes dropping inside the window is one outage', () => {
    const m = model(
      [
        [3, off(10_000)],
        [41, off(10_100)],
        [42, off(10_000 - PDU_GROUP_WINDOW_MS)]
      ],
      [43]
    )
    expect(m.outages).toEqual([
      { pduId: 3, nodeIds: [41, 42], fedCount: 3, at: 10_000, neverSeen: false }
    ])
  })

  it('half or fewer is not an outage, nor are drops outside the window', () => {
    expect(
      model(
        [
          [3, off(10_000)],
          [41, off(10_000)]
        ],
        [42, 43]
      ).outages
    ).toEqual([])
    expect(
      model(
        [
          [3, off(10_000)],
          [41, off(10_000 + PDU_GROUP_WINDOW_MS + 1)],
          [42, off(10_000 + PDU_GROUP_WINDOW_MS + 1)]
        ],
        [43]
      ).outages
    ).toEqual([])
  })

  it('counts a drop the next roster poll found, but not an earlier one', () => {
    const late = model(
      [
        [3, off(10_000)],
        [41, off(10_000 + PDU_GROUP_POLL_CATCH_MS, 'roster')],
        [42, off(10_050)]
      ],
      [43]
    )
    expect(late.outages[0]?.nodeIds).toEqual([41, 42])
    const early = model(
      [
        [3, off(10_000)],
        [41, off(10_000 - PDU_GROUP_WINDOW_MS - 1, 'roster')],
        [42, off(10_050)]
      ],
      [43]
    )
    expect(early.outages).toEqual([])
  })

  it('a PDU found late by the roster still groups with nodes whose deltas came first', () => {
    const m = model([
      [3, off(15_000, 'roster')],
      [41, off(10_000)],
      [42, off(10_100)],
      [43, off(10_200)]
    ])
    expect(m.outages[0]).toMatchObject({ pduId: 3, nodeIds: [41, 42, 43] })
  })

  it('a PDU and its nodes all missing from the first roster group together, as never seen', () => {
    const m = buildNodeModel(input({ file, rosterCompleteAt: 2000 }))
    expect(m.outages.find((o) => o.pduId === 3)).toEqual({
      pduId: 3,
      nodeIds: [41, 42, 43],
      fedCount: 3,
      at: 2000,
      neverSeen: true
    })
    expect(m.nodes.find((n) => n.nodeId === 3)?.seenOnline).toBe(false)
  })

  it('an outage is not never-seen when any board in it was online this session', () => {
    const m = model([
      [3, { firstSeenAt: 0, offlineAt: 10_000, offlineVia: 'delta' }],
      [41, off(10_000)],
      [42, { firstSeenAt: 0, offlineAt: 10_000, offlineVia: 'delta' }]
    ])
    expect(m.outages[0]).toMatchObject({ pduId: 3, nodeIds: [41, 42], neverSeen: false })
    expect(m.nodes.filter((n) => n.seenOnline).map((n) => n.nodeId)).toEqual([41])
  })

  it('an online PDU is never an outage', () => {
    expect(
      model(
        [
          [41, off(0)],
          [42, off(0)],
          [43, off(0)]
        ],
        [3]
      ).outages
    ).toEqual([])
  })
})

describe('differingCount', () => {
  it('is carried on the model', () => {
    const file: NodeMappingFile = { version: 1, nodes: { 1: { name: 'X' } }, ignored: [] }
    expect(buildNodeModel(input({ file })).differingCount).toBe(1)
  })
})

describe('ignoredNodes', () => {
  const file: NodeMappingFile = {
    version: 1,
    nodes: {},
    ignored: [3, 47, 52, 58],
    ignoredMeta: { 47: { at: '2026-10-12T10:00:00.000Z', kind: 'panel' } }
  }

  it('names registry ids, keeps the recorded kind, and says when each was ignored', () => {
    const m = buildNodeModel(input({ file, telemetry: [telem(52)] }))
    expect(m.ignored).toEqual([3, 47, 52, 58])
    expect(m.ignoredNodes).toEqual([
      { nodeId: 3, name: 'PDU_Left', kind: 'pdu' },
      { nodeId: 47, kind: 'panel', ignoredAt: '2026-10-12T10:00:00.000Z' },
      { nodeId: 52, kind: 'pdu' }, // sends _NODE_TELEM, so a PDU
      { nodeId: 58 } // nothing known
    ])
  })

  it('last seen is this session only: reporting now, offline since, or not seen', () => {
    const seen = new Map<number, NodeSeen>([[52, { firstSeenAt: 1, offlineAt: 5000 }]])
    const m = buildNodeModel(input({ file, roster: [st(47), st(52, false)], seen }))
    const last = Object.fromEntries(m.ignoredNodes.map((n) => [n.nodeId, n.lastSeen]))
    expect(last).toEqual({ 3: undefined, 47: 'now', 52: 5000, 58: undefined })
    expect(m.nodes.map((n) => n.nodeId)).not.toContain(47) // still left out of the roster view
  })
})

describe('cameOnline', () => {
  it('lists only nodes that were not present at the previous roster change', () => {
    expect(cameOnline(new Set(), [st(1), st(2, false)])).toEqual([1]) // first roster
    expect(cameOnline(new Set([1]), [st(1), st(2)])).toEqual([2]) // 1 still present
    expect(cameOnline(new Set([1]), [st(1, false)])).toEqual([]) // gone
    expect(cameOnline(new Set(), [st(1)])).toEqual([1]) // back after being gone
  })
})

describe('board kind (#344)', () => {
  const kind = (id: number, k: number, present = true) => ({ ...st(id, present), nodeKind: k })

  it("leaves out the bridge's own row (node 0): it is the link, not a cockpit node", () => {
    const m = buildNodeModel(input({ roster: [kind(0, 3), st(1)], rosterCompleteAt: 0 }))
    expect(m.nodes.map((n) => n.nodeId)).not.toContain(0)
  })

  it('identifies by what the node reports, then PDU telemetry, then the stored kind', () => {
    const m = buildNodeModel(
      input({ roster: [kind(41, 1), kind(42, 0), kind(2, 2)], telemetry: [telem(42)] })
    )
    const by = (id: number) => m.nodes.find((n) => n.nodeId === id)
    expect(by(41)).toMatchObject({ identified: 'panel', kind: 'panel' })
    expect(by(42)).toMatchObject({ identified: 'pdu', kind: 'pdu' }) // telemetry only
    expect(by(2)).toMatchObject({ identified: 'pdu', kind: 'pdu', pduId: null }) // reports PDU
    expect(by(3)).toMatchObject({ identified: 'pdu' }) // registry PDU, silent
  })

  it('a new node that has not reported its kind is not identified, and not news', () => {
    const m = buildNodeModel(input({ roster: [kind(41, 0)], rosterCompleteAt: 0 }))
    const n41 = m.nodes.find((n) => n.nodeId === 41)!
    expect(n41.identified).toBeUndefined()
    expect(n41.kind).toBe('panel') // the drawing default
    expect(isReportableNew(n41)).toBe(false)
  })

  it('isReportableNew: new, on the bus, and identified as a PDU or a panel group', () => {
    const m = buildNodeModel(
      input({
        roster: [kind(41, 1), kind(42, 2), kind(43, 3), kind(44, 1, false), kind(45, 0)],
        rosterCompleteAt: 0
      })
    )
    expect(m.nodes.filter(isReportableNew).map((n) => n.nodeId)).toEqual([41, 42])
  })
})
