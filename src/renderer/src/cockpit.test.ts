import { describe, expect, it } from 'vitest'
import type { NodeModel, NodeModelEntry, PduOutage } from '@shared/node-rules'
import type { NodeStatus } from '@shared/nodes'
import { PDU_FLAG, RAIL_FLAG, TELEM_PAGE, type NodeTelemSnapshot } from '@shared/node-telem'
import {
  STATE_SYMBOL,
  attentionItems,
  consoleKey,
  healthBand,
  newCount,
  nodeHealth,
  nodeViews,
  outageHint,
  pduAlertFlags,
  planLayout,
  tileMatches,
  totalWatts
} from './cockpit'

const status = (nodeId: number, over: Partial<NodeStatus> = {}): NodeStatus => ({
  nodeId,
  present: true,
  boff: false,
  epvf: false,
  uptimeSec: 100,
  rxCount: 10,
  tec: 0,
  rec: 0,
  dieTempC: 30,
  overheat: false,
  degraded: false,
  faultId: 0,
  ...over
})

const node = (nodeId: number, over: Partial<NodeModelEntry> = {}): NodeModelEntry => ({
  nodeId,
  name: `Node_${nodeId}`,
  console: 'Center',
  pduId: null,
  kind: 'panel',
  source: 'registry',
  availability: 'online',
  status: status(nodeId),
  differs: false,
  ...over
})

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

const model = (nodes: NodeModelEntry[], outages: PduOutage[] = []): NodeModel => ({
  nodes,
  outages,
  differingCount: 0,
  ignored: [],
  ignoredNodes: [],
  hidden: [],
  rosterComplete: true
})

describe('nodeHealth', () => {
  it('maps every state to a symbol, healthy and unknown to none', () => {
    expect(STATE_SYMBOL).toEqual({ on: '', warn: '!', off: '✕', new: '+', unknown: '' })
  })

  it('offline wins over every flag', () => {
    const e = node(1, { availability: 'offline', status: status(1, { degraded: true }) })
    expect(nodeHealth(e)).toEqual({ state: 'off', flag: 'OFFLINE' })
  })

  it('a new node is new, even when it reports flags', () => {
    expect(nodeHealth(node(41, { source: 'new', status: status(41, { epvf: true }) })).state).toBe(
      'new'
    )
  })

  it('no complete roster yet and never reported → unknown, not offline', () => {
    expect(nodeHealth(node(1, { availability: 'unknown', status: undefined }))).toEqual({
      state: 'unknown'
    })
  })

  it('bus-off reads as offline', () => {
    expect(nodeHealth(node(1, { status: status(1, { boff: true }) }))).toEqual({
      state: 'off',
      flag: 'BUS-OFF'
    })
  })

  it('collects the node’s own flags: fault tag, overheat, error-passive', () => {
    const e = node(2, {
      status: status(2, {
        degraded: true,
        faultId: 3,
        faultAbbr: 'I2C',
        overheat: true,
        epvf: true
      })
    })
    expect(nodeHealth(e)).toEqual({ state: 'warn', flag: 'I2C · OVERHEAT · ERR-PASSIVE' })
  })

  it('a PDU warns on its rail and status alert flags, not on calibration state', () => {
    const v = nodeViews(model([pdu(4, 'Right')]), [
      telem(4, { flags5: RAIL_FLAG.UNDER_V, status: PDU_FLAG.UNCAL_ZERO | PDU_FLAG.TEMP_WARN })
    ])[0]!
    expect(v.health).toEqual({ state: 'warn', flag: '5V UNDER-V · TEMP WARN' })
  })

  it('ignores flags on stale pages', () => {
    const v = nodeViews(model([pdu(4, 'Right')]), [
      telem(4, { flags5: RAIL_FLAG.FUSE_OPEN, stale: true })
    ])[0]!
    expect(v.health.state).toBe('on')
    expect(v.readings).toEqual({})
  })
})

describe('pduAlertFlags', () => {
  it('names each rail flag with its rail', () => {
    const r = { kind: 'rail' as const, vAvgMv: 0, vMinMv: 0, iAvgMa: 0 }
    expect(
      pduAlertFlags({
        rail12V: { ...r, page: 1, flags: RAIL_FLAG.OVER_CURRENT | RAIL_FLAG.SENSOR_FAULT },
        rail5V: { ...r, page: 2, flags: RAIL_FLAG.OVER_V }
      })
    ).toEqual(['12V OVER-I', '12V SENSOR FAULT', '5V OVER-V'])
  })
})

describe('nodeViews', () => {
  it('an online PDU without fresh pages has no readings', () => {
    const [v] = nodeViews(model([pdu(3, 'Left', { readings: 'none' })]), [])
    expect(v!.noReadings).toBe(true)
  })

  it('an offline PDU has no readings even while its last pages are still fresh', () => {
    const [v] = nodeViews(model([pdu(3, 'Left', { availability: 'offline' })]), [telem(3)])
    expect(v!.readings).toEqual({})
  })
})

describe('tileMatches', () => {
  const [ok, bad] = nodeViews(
    model([
      node(1, { name: 'Center_Armament' }),
      node(2, { name: 'Right_Navigation', availability: 'offline' })
    ]),
    []
  )

  it('matches name (case-insensitive) or NODE_ID, with or without #', () => {
    expect(tileMatches(ok!, 'armam', false)).toBe(true)
    expect(tileMatches(ok!, '#1', false)).toBe(true)
    expect(tileMatches(ok!, '1', false)).toBe(true)
    expect(tileMatches(ok!, 'nav', false)).toBe(false)
  })

  it('Issues keeps only nodes with a problem', () => {
    expect(tileMatches(ok!, '', true)).toBe(false)
    expect(tileMatches(bad!, '', true)).toBe(true)
  })
})

describe('consoleKey', () => {
  it('maps NODE_IDS consoles; anything else lands on the instrument panel', () => {
    expect(consoleKey('Left')).toBe('L')
    expect(consoleKey('Right')).toBe('R')
    expect(consoleKey('Center')).toBe('C')
    expect(consoleKey('Aft')).toBe('C')
    expect(consoleKey(null)).toBe('C')
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
    const l = planLayout(nodeViews(model(nodes), []), [])
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
    const l = planLayout(
      nodeViews(model([pdu(4, 'Right'), node(1, { console: 'Center', pduId: 4 })]), []),
      []
    )
    expect(l.groups).toHaveLength(1)
    expect(l.groups[0]!.tiles[0]!.view.entry.nodeId).toBe(1)
  })

  it('never places new nodes', () => {
    const l = planLayout(nodeViews(model(nodes), []), [])
    expect(l.groups.flatMap((g) => g.tiles).some((t) => t.view.entry.nodeId === 41)).toBe(false)
  })

  it('strips the console prefix from tile names', () => {
    const l = planLayout(nodeViews(model(nodes), []), [])
    expect(l.groups.find((g) => g.key === 'pdu-5')!.tiles[0]!.short).toBe('Armament')
  })

  it('lays tiles out in the console’s columns, row by row', () => {
    const left = Array.from({ length: 3 }, (_, i) => node(10 + i, { console: 'Left', pduId: 3 }))
    const g = planLayout(nodeViews(model([pdu(3, 'Left'), ...left]), []), []).groups[0]!
    const [a, b, c] = g.tiles
    expect(a!.y).toBe(b!.y)
    expect(b!.x).toBeGreaterThan(a!.x)
    expect(c!.x).toBe(a!.x)
    expect(c!.y).toBeGreaterThan(a!.y)
  })

  it('draws one feed line per PDU, gold when it raises a rail flag', () => {
    const l = planLayout(
      nodeViews(model(nodes), [telem(4, { flags5: RAIL_FLAG.UNDER_V }), telem(3)]),
      []
    )
    expect(l.wires).toHaveLength(4)
    expect(l.wires.filter((w) => w.alert)).toHaveLength(1)
  })

  it('grows the stage when a console overflows', () => {
    const many = Array.from({ length: 30 }, (_, i) => node(10 + i, { console: 'Left', pduId: 3 }))
    const l = planLayout(nodeViews(model([pdu(3, 'Left'), ...many]), []), [])
    expect(l.height).toBeGreaterThan(600)
    expect(l.psu.y + 52).toBe(l.height)
  })

  it('adds the outage hint under the dropped PDU', () => {
    const o: PduOutage = { pduId: 6, nodeIds: [7], fedCount: 1, at: 1 }
    const l = planLayout(nodeViews(model(nodes, [o]), []), [o])
    const g = l.groups.find((x) => x.key === 'pdu-6')!
    expect(g.outage).toBe(o)
    expect(g.hint!.text).toMatch(/^All 1 nodes on this PDU lost power together/)
  })
})

describe('outageHint', () => {
  it('says "N of M" when only some fed nodes dropped', () => {
    expect(outageHint({ pduId: 3, nodeIds: [1, 2, 3], fedCount: 4, at: 0 })).toBe(
      '3 of 4 nodes on this PDU lost power together — a blown 5 V fuse at the PDU looks like this.'
    )
  })
})

describe('attentionItems', () => {
  it('orders outages, then offline, then warnings, each by NODE_ID', () => {
    const nodes = [
      node(1, { status: status(1, { epvf: true }) }),
      node(2, { availability: 'offline' }),
      node(9, { status: status(9, { boff: true }) }),
      pdu(6, 'Center', { availability: 'offline' }),
      node(7, { pduId: 6, availability: 'offline' }),
      node(8, { pduId: 6, availability: 'offline' }),
      node(41, { source: 'new' })
    ]
    const o: PduOutage = { pduId: 6, nodeIds: [7, 8], fedCount: 2, at: 1 }
    const items = attentionItems(nodeViews(model(nodes, [o]), []), [o])
    expect(items.map((i) => [i.nodeId, i.flag])).toEqual([
      [6, 'OFFLINE · 2 nodes affected'],
      [2, 'OFFLINE'],
      [9, 'BUS-OFF'],
      [1, 'ERR-PASSIVE']
    ])
    expect(items[0]!.outage).toBe(o)
  })

  it('a PDU without readings is not an item', () => {
    expect(
      attentionItems(nodeViews(model([pdu(3, 'Left', { readings: 'none' })]), []), [])
    ).toEqual([])
  })
})

describe('healthBand', () => {
  const nodes = [
    pdu(3, 'Left'),
    pdu(4, 'Right'),
    pdu(5, 'Center', { readings: 'none' }),
    node(1, { status: status(1, { tec: 8, rec: 2 }) }),
    node(2, { availability: 'offline' }),
    node(7, { status: status(7, { boff: true, tec: 3 }) }),
    node(41, { source: 'new' })
  ]
  const telemetry = [
    telem(3, { v12: 12_000, i12: 1000, v5: 5000, i5: 500, ntc: 31.4 }),
    telem(4, { v12: 12_000, i12: 2000, v5: 4700, i5: -20, ntc: 41.3, status: PDU_FLAG.TEMP_WARN })
  ]
  const b = healthBand(nodeViews(model(nodes), telemetry))

  it('counts known nodes only (new ones wait in their own prompt)', () => {
    expect([b.online, b.total, b.warn, b.off, b.unknown]).toEqual([4, 6, 1, 2, 0])
  })

  it('sums amps and watts over PDUs with readings; a negative offset reads as 0', () => {
    expect(b.amps12).toBeCloseTo(3)
    expect(b.amps5).toBeCloseTo(0.5)
    expect(b.watts12).toBeCloseTo(36)
    expect(b.watts).toBeCloseTo(36 + 2.5)
    expect([b.pdusWith, b.pdusWithout]).toEqual([2, 1])
  })

  it('finds the lowest 5 V rail, worst CAN counters, bus-off count and the hottest PDU', () => {
    expect(b.low5).toEqual({ volts: 4.7, nodeId: 4, name: 'PDU_Right' })
    expect(b.worstCan).toMatchObject({ nodeId: 1, tec: 8 })
    expect(b.busOff).toBe(1)
    expect(b.hottest).toEqual({ tempC: 41.3, nodeId: 4, name: 'PDU_Right', level: 'warn' })
  })

  it('has no totals when no PDU has readings', () => {
    const e = healthBand(nodeViews(model([pdu(3, 'Left', { readings: 'none' })]), []))
    expect([e.amps12, e.amps5, e.watts, e.hottest]).toEqual([null, null, null, undefined])
    expect(totalWatts([])).toBeNull()
  })

  it('leaves out a PDU still waiting to be adopted, as the Total card does', () => {
    const views = nodeViews(model([pdu(3, 'Left'), pdu(42, 'Left', { source: 'new' })]), [
      telem(3, { i12: 1000, i5: 0 }),
      telem(42, { i12: 1000, i5: 0 })
    ])
    expect(totalWatts(views)).toBeCloseTo(12)
    expect(healthBand(views).watts).toBeCloseTo(12)
  })
})

describe('newCount', () => {
  it('counts the NODE_IDs waiting to be adopted', () => {
    expect(
      newCount(model([node(1), node(41, { source: 'new' }), node(42, { source: 'new' })]))
    ).toBe(2)
  })
})
