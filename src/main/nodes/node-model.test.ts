import { describe, expect, it } from 'vitest'
import {
  buildNodeModel,
  isReportableNew,
  nodeAvailability,
  onBusNow,
  type NodeModelInput
} from './node-model'
import { cockpitMembers } from './cockpit-snapshot/members'
import { adoptRows } from './cockpit-snapshot/adopt'
import { nodeViews } from './cockpit-snapshot/views'
import { PDU_GROUP_POLL_CATCH_MS, PDU_GROUP_WINDOW_MS } from './power-zone'
import { EMPTY_MAPPING } from './mapping-rules'
import { registryDefaults } from './registry'
import type { NodeMappingFile, NodeSeen, NodeStatus, NodeTelemSnapshot } from '@shared/nodes'
import { nodeStatus } from '../../test-fixtures/nodes'

const defaults = registryDefaults({
  0: { name: 'PanelBridge', console: '—' },
  1: { name: 'Center_Armament', console: 'Center' },
  2: { name: 'Right_Navigation', console: 'Right' },
  3: { name: 'PDU_Left', console: 'Left' },
  4: { name: 'PDU_Right', console: 'Right' },
  5: { name: 'PDU_Center', console: 'Center' }
})

const st = (nodeId: number, present = true): NodeStatus =>
  nodeStatus(nodeId, { present, uptimeSec: 0, rxCount: 0, dieTempC: null })
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

const SEEN = '2026-10-14T21:14:00.000Z'
/** Every registry board was added and seen in an earlier session — the cockpit these tests assume. */
const everSeen = (file: NodeMappingFile): NodeMappingFile => {
  const nodes = { ...file.nodes }
  for (const id of defaults.keys()) nodes[id] = { added: true, lastSeen: SEEN, ...nodes[id] }
  return { ...file, nodes }
}
const input = (over: Partial<NodeModelInput>): NodeModelInput => ({
  roster: [],
  seen: new Map(),
  telemetry: [],
  defaults,
  ...over,
  file: everSeen(over.file ?? EMPTY_MAPPING)
})
/** As input(), but registry boards are in your cockpit only if the file says so (#93). */
const fresh = (over: Partial<NodeModelInput>): NodeModelInput => ({
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
  it('remembered boards are unknown until the first complete roster, then not seen if missing', () => {
    expect(entry(input({}), 1)?.availability).toBe('unknown')
    const after = input({ roster: [st(2)], rosterCompleteAt: 500 })
    const e = entry(after, 1)
    // Missing from this session's roster: not "offline since 500" — that is only when the roster
    // came (#93). When it was last on the bus comes from node-mapping.json.
    expect(e).toMatchObject({
      availability: 'offline',
      notSeen: true,
      lastSeenAt: Date.parse(SEEN)
    })
    expect(e?.offlineAt).toBeUndefined()
    expect(entry(after, 2)?.availability).toBe('online')
  })

  it('a board the roster lists as gone this session is offline since then, not "not seen"', () => {
    const after = input({ roster: [st(1, false)], rosterCompleteAt: 500 })
    expect(entry(after, 1)).toMatchObject({ availability: 'offline', offlineAt: 500 })
    expect(entry(after, 1)?.notSeen).toBeUndefined()
  })

  it('a node reported absent is offline with its own timing, and its last report kept', () => {
    const seen = new Map<number, NodeSeen>([
      [1, { firstSeenAt: 0, reportedAt: 400, offlineAt: 900, offlineVia: 'delta' }]
    ])
    expect(entry(input({ roster: [st(1, false)], seen }), 1)).toMatchObject({
      availability: 'offline',
      offlineAt: 900,
      offlineVia: 'delta',
      reportedAt: 400
    })
  })

  it('hidden nodes are skipped (not offline)', () => {
    const file: NodeMappingFile = { version: 4, nodes: { 2: { hidden: true } } }
    const m = buildNodeModel(input({ file, rosterCompleteAt: 0 }))
    expect(m.nodes.map((n) => n.nodeId)).toEqual([1, 3, 4, 5])
    expect(m.hidden).toEqual([2])
  })

  // Review of #85: Settings › Hidden nodes showed registry names, not what the Cockpit showed.
  // X1: a hidden board is still in your cockpit, so each also carries its kind and source.
  it('lists each hidden node with the name and console the Cockpit showed', () => {
    const file: NodeMappingFile = {
      version: 4,
      nodes: {
        2: { hidden: true, name: 'Nav_Repeater', console: 'Left' },
        41: {
          added: true,
          hidden: true,
          name: 'Left_Lights',
          console: 'Left',
          kind: 'panel',
          pduId: 3
        }
      }
    }
    const m = buildNodeModel(input({ file, rosterCompleteAt: 0 }))
    expect(m.hidden).toEqual([2, 41])
    // X7: each carries its power zone too, so a PDU's Feeds and Forget count hidden boards.
    expect(m.hiddenNodes).toEqual([
      {
        nodeId: 2,
        name: 'Nav_Repeater',
        console: 'Left',
        kind: 'panel',
        source: 'registry',
        pduId: 4
      },
      {
        nodeId: 41,
        name: 'Left_Lights',
        console: 'Left',
        kind: 'panel',
        source: 'adopted',
        pduId: 3
      }
    ])
  })

  it('a hidden PDU is still a PDU in your cockpit (X1: never "(not added)")', () => {
    const file: NodeMappingFile = { version: 4, nodes: { 4: { hidden: true } } }
    expect(buildNodeModel(input({ file })).hiddenNodes).toEqual([
      { nodeId: 4, name: 'PDU_Right', console: 'Right', kind: 'pdu', source: 'registry' }
    ])
  })

  it('a hidden registry node with no overrides keeps its registry name', () => {
    const file: NodeMappingFile = { version: 4, nodes: { 2: { hidden: true } } }
    expect(buildNodeModel(input({ file })).hiddenNodes).toEqual([
      {
        nodeId: 2,
        name: 'Right_Navigation',
        console: 'Right',
        kind: 'panel',
        source: 'registry',
        pduId: 4 // X7: its zone, PDU_Right, in your cockpit
      }
    ])
  })
})

describe('the one availability rule: roster, telemetry, none (X2 / S10, #132)', () => {
  it('online by the roster, else by fresh PDU pages, else offline by the roster, else unknown', () => {
    expect(nodeAvailability(st(4), false, false)).toEqual({
      availability: 'online',
      evidence: 'roster'
    })
    // Fresh pages count as online whatever the roster says: no row, absent, or no roster yet.
    for (const [row, complete] of [
      [undefined, false],
      [undefined, true],
      [st(4, false), true]
    ] as const) {
      expect(nodeAvailability(row, complete, true)).toEqual({
        availability: 'online',
        evidence: 'telemetry'
      })
    }
    expect(nodeAvailability(st(4, false), false, false)).toEqual({
      availability: 'offline',
      evidence: 'roster'
    })
    expect(nodeAvailability(undefined, true, false)).toEqual({
      availability: 'offline',
      evidence: 'roster'
    })
    expect(nodeAvailability(undefined, false, false)).toEqual({
      availability: 'unknown',
      evidence: 'none'
    })
  })

  it('a PDU in your cockpit sending fresh pages is online, roster or not; stale pages are not', () => {
    // A complete roster left PDU_Left (#3) out, or listed it absent: its fresh pages say it is on.
    expect(entry(input({ telemetry: [telem(3)], rosterCompleteAt: 0 }), 3)).toMatchObject({
      availability: 'online',
      readings: 'live'
    })
    expect(entry(input({ roster: [st(3, false)], telemetry: [telem(3)] }), 3)).toMatchObject({
      availability: 'online',
      readings: 'live'
    })
    expect(entry(input({ telemetry: [telem(3)] }), 3)?.availability).toBe('online') // no roster yet
    const stale = [telem(3, { stale: true })]
    expect(entry(input({ telemetry: stale, rosterCompleteAt: 0 }), 3)?.availability).toBe('offline')
    expect(entry(input({ telemetry: stale }), 3)?.availability).toBe('unknown')
  })

  it('no "new but offline, can’t adopt" board: a registry PDU seen by its pages alone is adoptable', () => {
    for (const roster of [[], [st(3, false)]]) {
      const m = buildNodeModel(fresh({ roster, telemetry: [telem(3)], rosterCompleteAt: 0 }))
      const e = m.nodes.find((n) => n.nodeId === 3)!
      expect(e).toMatchObject({ source: 'new', availability: 'online', identified: 'pdu' })
      expect(isReportableNew(e, true)).toBe(true)
      const [row] = adoptRows(nodeViews(m, [telem(3)]), cockpitMembers(m))
      expect(row).toMatchObject({ kind: 'pdu', badge: 'PDU' })
      expect(row?.evidence.reporting).toMatch(/^telemetry: 12 V/)
    }
  })

  it('every new board in the model is on the bus: none is offline', () => {
    const m = buildNodeModel(
      fresh({
        roster: [{ ...st(1), nodeKind: 1 }, st(2, false), st(50), st(51, false)],
        telemetry: [telem(3), telem(4, { stale: true })],
        rosterCompleteAt: 0
      })
    )
    const newOnes = m.nodes.filter((n) => n.source === 'new')
    expect(newOnes.map((n) => [n.nodeId, n.availability])).toEqual([
      [1, 'online'],
      [3, 'online'],
      [50, 'online']
    ])
  })

  it('onBusNow: online, and only while the link is up', () => {
    expect(onBusNow({ availability: 'online' }, true)).toBe(true)
    expect(onBusNow({ availability: 'online' }, false)).toBe(false)
    expect(onBusNow({ availability: 'offline' }, true)).toBe(false)
    expect(onBusNow({ availability: 'unknown' }, true)).toBe(false)
    const e = buildNodeModel(fresh({ roster: [{ ...st(1), nodeKind: 1 }], rosterCompleteAt: 0 }))
      .nodes[0]!
    expect(isReportableNew(e, true)).toBe(true)
    expect(isReportableNew(e, false)).toBe(false)
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

  it('added registry and adopted ids are never new', () => {
    const file: NodeMappingFile = {
      version: 4,
      nodes: {
        1: { added: true },
        41: { added: true, name: 'Trim', console: 'Left', pduId: 3, kind: 'panel' }
      }
    }
    const m = buildNodeModel(fresh({ roster: [st(1), st(41)], file }))
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
    version: 4,
    nodes: {
      41: { added: true, name: 'A', console: 'Left', pduId: 3, kind: 'panel' },
      42: { added: true, name: 'B', console: 'Left', pduId: 3, kind: 'panel' },
      43: { added: true, name: 'C', console: 'Left', pduId: 3, kind: 'panel' }
    }
  }
  const off = (at: number, via: 'delta' | 'roster' = 'delta'): NodeSeen => ({
    firstSeenAt: 0,
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
    expect(m.outages).toEqual([{ pduId: 3, nodeIds: [41, 42], fedCount: 3, at: 10_000 }])
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

  it('a hidden board it feeds counts for neither side of an outage (X7)', () => {
    // 43 is hidden (offline, off the plan): still fed by PDU_Left — Forget unlinks it — but it
    // could not have dropped with it, so "N of M" is out of the two on the plan.
    const hidden: NodeMappingFile = {
      ...file,
      nodes: { ...file.nodes, 43: { ...file.nodes[43]!, hidden: true } }
    }
    const m = buildNodeModel(
      input({
        file: hidden,
        roster: [st(3, false), st(41, false), st(42, false), st(43, false)],
        seen: new Map([
          [3, off(10_000)],
          [41, off(10_000)],
          [42, off(10_000)],
          [43, off(10_000)]
        ])
      })
    )
    expect(m.hiddenNodes.map((h) => [h.nodeId, h.pduId])).toEqual([[43, 3]])
    expect(m.outages).toEqual([{ pduId: 3, nodeIds: [41, 42], fedCount: 2, at: 10_000 }])
  })

  it('a PDU and its nodes all missing from the first roster: not seen, never an outage (#93)', () => {
    const m = buildNodeModel(input({ file, rosterCompleteAt: 2000 }))
    expect(m.outages).toEqual([])
    expect(m.nodes.filter((n) => [3, 41].includes(n.nodeId)).map((n) => n.notSeen)).toEqual([
      true,
      true
    ])
  })

  it('a PDU and its nodes listed as gone in the first roster still group together', () => {
    const roster = [st(3, false), st(41, false), st(42, false), st(43, false)]
    const m = buildNodeModel(input({ file, roster, rosterCompleteAt: 2000 }))
    expect(m.outages.find((o) => o.pduId === 3)).toEqual({
      pduId: 3,
      nodeIds: [41, 42, 43],
      fedCount: 3,
      at: 2000
    })
  })

  it('fed boards not seen this session count for neither side (#93 review)', () => {
    // PDU_Left (3) feeds 41, 42, 43; only 41 is listed this session, and it dropped with the PDU.
    const roster = [st(3, false), st(41, false)]
    const seen = new Map<number, NodeSeen>([
      [3, off(1000)],
      [41, off(1000)]
    ])
    const m = buildNodeModel(input({ file, roster, seen, rosterCompleteAt: 0 }))
    expect(m.nodes.filter((n) => n.pduId === 3 && n.notSeen).map((n) => n.nodeId)).toEqual([42, 43])
    // Counting 42 and 43 made it "1 of 3" — no outage. They could not have dropped with it.
    expect(m.outages).toEqual([{ pduId: 3, nodeIds: [41], fedCount: 1, at: 1000 }])
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
    const file: NodeMappingFile = { version: 4, nodes: { 1: { name: 'X' } } }
    expect(buildNodeModel(input({ file })).differingCount).toBe(1)
  })
})

describe('your cockpit (#93)', () => {
  it('a registry board never added is not drawn; on the bus it waits as new, pre-filled', () => {
    const m = buildNodeModel(fresh({ roster: [{ ...st(1), nodeKind: 1 }], rosterCompleteAt: 0 }))
    expect(m.nodes).toHaveLength(1) // 2–5 are dictionary entries only
    expect(m.nodes[0]).toMatchObject({
      nodeId: 1,
      source: 'new',
      name: 'Center_Armament',
      identified: 'panel', // reported by the board
      console: null,
      pduId: null,
      // D7: its NODE_IDS.md PDU (PDU_Center) is not in your cockpit, so the pre-fill has none.
      registry: { name: 'Center_Armament', console: 'Center', pduId: null }
    })
    expect(isReportableNew(m.nodes[0]!, true)).toBe(true)
    expect(m.outages).toEqual([])
  })

  it('a registry board is identified only by what it reports, never by its NODE_ID (#93 re-review)', () => {
    const m = buildNodeModel(fresh({ roster: [st(1)], rosterCompleteAt: 0 })) // kind 0: not yet
    expect(m.nodes[0]?.identified).toBeUndefined()
    expect(isReportableNew(m.nodes[0]!, true)).toBe(false) // not news until it says what it is
    expect(m.nodes[0]?.registry?.name).toBe('Center_Armament') // the pre-fill is still there
    // Its own report wins over NODE_IDS.md: a registry panel ID reporting PDU is a PDU.
    const pdu = buildNodeModel(fresh({ roster: [{ ...st(2), nodeKind: 2 }], rosterCompleteAt: 0 }))
    expect(pdu.nodes[0]?.identified).toBe('pdu')
  })

  it('added and adopted boards are in it; anything else on the bus is new', () => {
    const file: NodeMappingFile = {
      version: 4,
      nodes: {
        2: { added: true, lastSeen: SEEN },
        4: { added: true, name: 'PDU_Starboard' },
        41: { added: true, name: 'Trim', console: 'Left', pduId: null, kind: 'panel' }
      }
    }
    const m = buildNodeModel(fresh({ file, roster: [st(1), st(50)], rosterCompleteAt: 0 }))
    expect(m.nodes.map((n) => [n.nodeId, n.source])).toEqual([
      [1, 'new'], // registry, reporting, not added yet
      [2, 'registry'],
      [4, 'registry'],
      [41, 'adopted'],
      [50, 'new']
    ])
  })

  it('a board not in your cockpit that went away is not listed, registry or not', () => {
    // Not added / not adopted (or just forgotten), and gone from the bus: it comes back as new
    // when it reports again (#93 re-review, user decision).
    const m = buildNodeModel(fresh({ roster: [st(2, false), st(50, false)], rosterCompleteAt: 0 }))
    expect(m.nodes).toEqual([])
    const back = buildNodeModel(fresh({ roster: [st(2, false), st(50)], rosterCompleteAt: 0 }))
    expect(back.nodes.map((n) => [n.nodeId, n.source])).toEqual([[50, 'new']])
  })

  it('a registry PDU sending pages is on the bus: it waits as new', () => {
    const m = buildNodeModel(fresh({ telemetry: [telem(3)], rosterCompleteAt: 0 }))
    expect(m.nodes.map((n) => [n.nodeId, n.source])).toEqual([[3, 'new']])
    expect(buildNodeModel(fresh({ telemetry: [telem(52)] })).nodes).toEqual([]) // unmapped: no
  })

  it('a registry PDU whose pages went stale (dropped, or forgotten) is not on the bus (#93 re-review)', () => {
    const stale = [telem(3, { stale: true })]
    expect(buildNodeModel(fresh({ telemetry: stale, rosterCompleteAt: 0 })).nodes).toEqual([])
    // In your cockpit it stays, as any board does.
    const file: NodeMappingFile = { version: 4, nodes: { 3: { added: true } } }
    const m = buildNodeModel(fresh({ file, telemetry: stale, rosterCompleteAt: 0 }))
    expect(m.nodes.map((n) => [n.nodeId, n.source])).toEqual([[3, 'registry']])
  })

  it('a board whose PDU is not in your cockpit has No power zone (D7)', () => {
    const file: NodeMappingFile = { version: 4, nodes: { 2: { added: true } } }
    const m = buildNodeModel(fresh({ file, roster: [st(2)], rosterCompleteAt: 0 }))
    expect(m.nodes).toHaveLength(1)
    expect(m.nodes[0]).toMatchObject({ nodeId: 2, pduId: null })
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
    expect(isReportableNew(n41, true)).toBe(false)
  })

  it('isReportableNew: new, on the bus, and identified as a PDU or a panel group', () => {
    const m = buildNodeModel(
      input({
        roster: [kind(41, 1), kind(42, 2), kind(43, 3), kind(44, 1, false), kind(45, 0)],
        rosterCompleteAt: 0
      })
    )
    expect(m.nodes.filter((n) => isReportableNew(n, true)).map((n) => n.nodeId)).toEqual([41, 42])
  })
})
