// Ported from the renderer's cockpit.test.ts (R3.2): the Cockpit's node views, Attention, health
// band and "New on the bus" count, now built in main. Same cases, same expected values.
import { describe, expect, it } from 'vitest'
import type { NodeModelEntry, NodeTelemSnapshot, PduOutage } from '@shared/nodes'
import {
  modelNode as node,
  nodeModel as model,
  nodeStatus as status
} from '../../../test-fixtures/nodes'
import { PDU_FLAG, RAIL_FLAG } from '@shared/nodes/legacy-rules'
import { TELEM_PAGE } from '../node-telem'
import { lastSeenLabel } from '@shared/format'
import { pduAlertFlags } from '../faults'
import { affected, attentionItems, newCount } from './attention'
import { canErrorsSub, canErrorsWorst, healthBand, totalWatts } from './band'
import { consoleKey } from './plan-zones'
import { nodeHealth, nodeViews } from './views'

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

describe('nodeHealth', () => {
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

describe('consoleKey', () => {
  it('maps NODE_IDS consoles; anything else lands on the instrument panel', () => {
    expect(consoleKey('Left')).toBe('L')
    expect(consoleKey('Right')).toBe('R')
    expect(consoleKey('Center')).toBe('C')
    expect(consoleKey('Aft')).toBe('C')
    expect(consoleKey(null)).toBe('C')
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

  it('a remembered board not seen this session says so, and when it last was (#93)', () => {
    const t = Date.UTC(2026, 9, 14, 21, 14)
    const nodes = [node(2, { availability: 'offline', notSeen: true, lastSeenAt: t })]
    expect(attentionItems(nodeViews(model(nodes), []), []).map((i) => i.flag)).toEqual([
      `NOT SEEN THIS SESSION · last seen ${lastSeenLabel(t)}`
    ])
  })

  it('new boards that can’t be adopted are warnings after the rest; their cog reviews (#93)', () => {
    const nodes = [node(1, { status: status(1, { epvf: true }) }), node(41, { source: 'new' })]
    const strays = [{ nodeId: 44, flag: 'SECOND SIMGATEWAY · can’t be adopted' }]
    const items = attentionItems(nodeViews(model(nodes), []), [], strays)
    expect(items.map((i) => [i.name, i.state, i.flag, !!i.stray])).toEqual([
      ['Node_1', 'warn', 'ERR-PASSIVE', false],
      ['NODE_ID 44', 'warn', 'SECOND SIMGATEWAY · can’t be adopted', true]
    ])
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

  it('a new board that can’t be adopted is on the bus and a warning (#93)', () => {
    const s = healthBand(nodeViews(model(nodes), telemetry), 1)
    expect([s.online, s.total, s.warn, s.off]).toEqual([5, 7, 2, 2])
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
    expect(canErrorsSub(b)).toBe('worst #7 · 1 bus-off') // the bus-off board is named first
    const quiet = healthBand(
      nodeViews(model([node(1, { status: status(1, { tec: 0, rec: 0 }) })]), [])
    )
    expect(canErrorsSub(quiet)).toBe('no errors · 0 bus-off') // no board named when all are 0
    expect(canErrorsSub(healthBand([]))).toBe('0 bus-off')
    // A bus-off board can read TEC 0: never "no errors" while one is bus-off — it is named first.
    const off = healthBand(
      nodeViews(
        model([
          node(1, { status: status(1, { tec: 40 }) }),
          node(7, { name: 'Center_Clock', status: status(7, { boff: true, tec: 0, rec: 0 }) })
        ]),
        []
      )
    )
    expect(canErrorsSub(off)).toBe('worst #7 · 1 bus-off')
    expect(canErrorsWorst(off)).toBe('Center_Clock')
    expect(canErrorsWorst(quiet)).toBeUndefined()
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
  it('counts new NODE_IDs on the bus that identified as something adoptable', () => {
    expect(
      newCount(
        model([
          node(1),
          node(41, { source: 'new', identified: 'panel' }),
          node(42, { source: 'new', identified: 'pdu' }),
          node(43, { source: 'new' }), // still identifying: not news yet
          node(44, { source: 'new', identified: 'bridge' }), // never adoptable
          node(45, { source: 'new', identified: 'pdu', availability: 'offline' }) // left the bus
        ])
      )
    ).toBe(2)
  })
})

describe('affected', () => {
  it('reads "1 node affected", and the plural from 2', () => {
    expect(affected(1)).toBe('1 node affected')
    expect(affected(2)).toBe('2 nodes affected')
  })
})
