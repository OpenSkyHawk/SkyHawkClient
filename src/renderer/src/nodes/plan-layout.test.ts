// The Cockpit plan's geometry (plan-layout.ts; from cockpit.test.ts, R3.2). The groups it lays out
// are main's (planZones), built here from the same views.
import { describe, expect, it } from 'vitest'
import type { NodeModelEntry, NodeTelemSnapshot, NodeView, PduOutage } from '@shared/nodes'
import { modelNode as node, nodeModel as model } from '../../test-fixtures/nodes'
// The firmware's PDU_RAIL_* bits (legacy-rules' RAIL_FLAG re-exported them; R3.2b).
import { PDU_RAIL_FLAGS as RAIL_FLAG } from '@shared/firmware'
import { TELEM_PAGE } from '../../main/nodes/node-telem'
import { planZones } from '../../main/nodes/cockpit-snapshot/plan-zones'
import { nodeViews } from '../../main/nodes/cockpit-snapshot/views'
import { outageHint, planLayout, shortName, tileWidth } from './plan-layout'

/** Main's zones for these views, laid out. */
const layout = (views: NodeView[], outages: PduOutage[]) => planLayout(planZones(views, outages))

const pdu = (nodeId: number, console: string, over: Partial<NodeModelEntry> = {}) =>
  node(nodeId, { name: `PDU_${console}`, console, kind: 'pdu', readings: 'live', ...over })

const rail = (page: 1 | 2, vAvgMv: number, iAvgMa: number, flags = 0, stale = false) => ({
  kind: 'rail' as const,
  page,
  flags,
  vAvgMv,
  vMinMv: vAvgMv - 20,
  iAvgMa,
  ageMs: stale ? 20_000 : 500,
  stale
})

const telem = (
  nodeId: number,
  o: {
    v12?: number
    i12?: number
    v5?: number
    i5?: number
    flags5?: number
    status?: number
    ntc?: number | null
    stale?: boolean
  } = {}
): NodeTelemSnapshot => ({
  nodeId,
  isPdu: true,
  rail12V: rail(TELEM_PAGE.PDU_RAIL_12V, o.v12 ?? 12_000, o.i12 ?? 1000, 0, o.stale),
  rail5V: rail(TELEM_PAGE.PDU_RAIL_5V, o.v5 ?? 5000, o.i5 ?? 500, o.flags5 ?? 0, o.stale),
  status: {
    kind: 'status',
    page: TELEM_PAGE.PDU_STATUS,
    flags: o.status ?? 0,
    ntcTempC: o.ntc === undefined ? 30 : o.ntc,
    i12PeakMa: 1500,
    i5PeakMa: 800,
    ageMs: o.stale ? 20_000 : 500,
    stale: !!o.stale
  },
  other: [],
  live: !o.stale
})

describe('shortName', () => {
  it('drops the console prefix however it is joined, never the whole name', () => {
    expect(shortName('Center_Armament')).toBe('Armament')
    expect(shortName('Center Armament')).toBe('Armament')
    expect(shortName('Left-Fuel')).toBe('Fuel')
    expect(shortName('Centerline')).toBe('Centerline')
    expect(shortName('Center')).toBe('Center')
  })
})

describe('planLayout', () => {
  const nodes = [
    node(1, { name: 'Center_Armament', console: 'Center', pduId: 5 }),
    node(2, { name: 'Right_Navigation', console: 'Right', pduId: 4 }),
    pdu(3, 'Left'),
    pdu(4, 'Right'),
    pdu(5, 'Center'),
    pdu(6, 'Center'),
    node(7, { name: 'Center_Clock', console: 'Center', pduId: 6 }),
    node(8, { name: 'Left_Loose', console: 'Left', pduId: null }),
    node(41, { source: 'new', console: null })
  ]

  it('one group per PDU on its console, then nodes without a power zone', () => {
    const l = layout(nodeViews(model(nodes), []), [])
    expect(
      l.groups.map((g) => [g.key, g.console, g.tiles.map((t) => t.view.entry.nodeId)])
    ).toEqual([
      ['pdu-3', 'L', []],
      ['none-L', 'L', [8]],
      ['pdu-5', 'C', [1]],
      ['pdu-6', 'C', [7]],
      ['pdu-4', 'R', [2]]
    ])
    expect(l.consoles.find((c) => c.key === 'C')!.sub).toBe('2 PDUs')
    expect(l.consoles.find((c) => c.key === 'L')!.sub).toBe('')
  })

  it('places a panel under its PDU even when its own console differs', () => {
    const l = layout(
      nodeViews(model([pdu(4, 'Right'), node(1, { console: 'Center', pduId: 4 })]), []),
      []
    )
    expect(l.groups).toHaveLength(1)
    expect(l.groups[0]!.tiles[0]!.view.entry.nodeId).toBe(1)
  })

  it('tiles fit their names, from the column width up to ~2 columns, then "…" (#93)', () => {
    expect(tileWidth('Armament', 99, 206)).toBe(99) // short: the column width
    expect(tileWidth('Fuel_Quantity_Gauge', 99, 206)).toBe(172) // room for the symbol always kept
    expect(tileWidth('Angle_Of_Attack_Indexer_Lights', 99, 206)).toBe(206) // capped
  })

  it('a board changing state never moves a tile (#93 re-review I)', () => {
    const names = ['Left_ARC51_UHF', 'Left_Fuel', 'Left_Trim']
    const at = (state: Partial<NodeModelEntry>) =>
      layout(
        nodeViews(
          model([
            pdu(3, 'Left'),
            ...names.map((name, i) => node(10 + i, { name, pduId: 3, ...(i === 0 ? state : {}) }))
          ]),
          []
        ),
        []
      ).groups[0]!.tiles.map((t) => [t.x, t.y, t.w])
    expect(at({ availability: 'offline' })).toEqual(at({})) // ✕ appears: same places, same widths
  })

  it('tiles flow left to right and wrap inside their group', () => {
    const names = ['Left_Engine', 'Left_ARC51_UHF_Radio', 'Left_Fuel', 'Left_Trim', 'Left_Gear']
    const l = layout(
      nodeViews(
        model([pdu(3, 'Left'), ...names.map((name, i) => node(10 + i, { name, pduId: 3 }))]),
        []
      ),
      []
    )
    const g = l.groups[0]!
    // Left console: 200 wide, two 96-px columns. ARC51 needs 145, so it takes its row.
    expect(g.tiles.map((t) => [t.short, t.x - g.x, t.y - g.tiles[0]!.y, t.w])).toEqual([
      ['Engine', 0, 0, 96],
      ['ARC51_UHF_Radio', 0, 42, 145],
      ['Fuel', 0, 84, 96],
      ['Trim', 104, 84, 96],
      ['Gear', 0, 126, 96]
    ])
    for (const t of g.tiles) expect(t.x + t.w).toBeLessThanOrEqual(g.x + g.w)
  })

  it('never places new nodes', () => {
    const l = layout(nodeViews(model(nodes), []), [])
    expect(l.groups.flatMap((g) => g.tiles).some((t) => t.view.entry.nodeId === 41)).toBe(false)
  })

  it('strips the console prefix from tile names', () => {
    const l = layout(nodeViews(model(nodes), []), [])
    expect(l.groups.find((g) => g.key === 'pdu-5')!.tiles[0]!.short).toBe('Armament')
  })

  it('lays tiles out in the console’s columns, row by row', () => {
    const left = Array.from({ length: 3 }, (_, i) => node(10 + i, { console: 'Left', pduId: 3 }))
    const g = layout(nodeViews(model([pdu(3, 'Left'), ...left]), []), []).groups[0]!
    const [a, b, c] = g.tiles
    expect(a!.y).toBe(b!.y)
    expect(b!.x).toBeGreaterThan(a!.x)
    expect(c!.x).toBe(a!.x)
    expect(c!.y).toBeGreaterThan(a!.y)
  })

  it('draws one feed line per PDU, gold when it raises a rail flag', () => {
    const l = layout(
      nodeViews(model(nodes), [telem(4, { flags5: RAIL_FLAG.UNDER_V }), telem(3)]),
      []
    )
    expect(l.wires).toHaveLength(4)
    expect(l.wires.filter((w) => w.alert)).toHaveLength(1)
  })

  it('grows the stage when a console overflows', () => {
    const many = Array.from({ length: 30 }, (_, i) => node(10 + i, { console: 'Left', pduId: 3 }))
    const l = layout(nodeViews(model([pdu(3, 'Left'), ...many]), []), [])
    expect(l.height).toBeGreaterThan(600)
    expect(l.psu.y + 52).toBe(l.height)
  })

  it('adds the outage hint under the dropped PDU', () => {
    const o: PduOutage = { pduId: 6, nodeIds: [7], fedCount: 1, at: 1 }
    const l = layout(nodeViews(model(nodes, [o]), []), [o])
    const g = l.groups.find((x) => x.key === 'pdu-6')!
    expect(g.outage).toBe(o)
    expect(g.hint!.text).toBe(
      'The only node on this PDU lost power with it — a blown 5 V fuse at the PDU looks like this.'
    )
  })
})

describe('outageHint', () => {
  it('says "N of M" when only some fed nodes dropped', () => {
    expect(outageHint({ pduId: 3, nodeIds: [1, 2, 3], fedCount: 4, at: 0 })).toBe(
      '3 of 4 nodes on this PDU lost power together — a blown 5 V fuse at the PDU looks like this.'
    )
  })

  it('says "All N" when every fed node dropped, and "The only node" for one', () => {
    expect(outageHint({ pduId: 3, nodeIds: [1, 2], fedCount: 2, at: 0 })).toBe(
      'All 2 nodes on this PDU lost power together — a blown 5 V fuse at the PDU looks like this.'
    )
    expect(outageHint({ pduId: 3, nodeIds: [1], fedCount: 1, at: 0 })).toBe(
      'The only node on this PDU lost power with it — a blown 5 V fuse at the PDU looks like this.'
    )
  })
})
