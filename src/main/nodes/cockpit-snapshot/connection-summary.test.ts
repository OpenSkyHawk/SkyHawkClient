// Ported from the renderer's connection-summary.test.ts (R3.2b): Connection › Connected nodes, now
// built in main (summaries.ts). Same cases, same expected values; the one that also checks the
// board symbols (a renderer table) stays in the renderer's node-view.test.ts.
import { describe, expect, it } from 'vitest'
import type { NodeModelEntry, NodeTelemSnapshot, PduOutage } from '@shared/nodes'
import {
  modelNode as node,
  nodeModel as model,
  nodeStatus as status
} from '../../../test-fixtures/nodes'
import { TELEM_PAGE } from '../node-telem'
import { fmtTime, lastSeenLabel } from '@shared/format'
import { boardZones } from '../power-zone'
import { cockpitMembers } from './members'
import { nodesSummary } from './summaries'
import { nodeViews } from './views'

const pdu = (nodeId: number, console: string, over: Partial<NodeModelEntry> = {}) =>
  node(nodeId, { name: `PDU_${console}`, console, kind: 'pdu', readings: 'live', ...over })

const rail = (page: 1 | 2, vAvgMv: number, iAvgMa: number) => ({
  kind: 'rail' as const,
  page,
  flags: 0,
  vAvgMv,
  vMinMv: vAvgMv - 20,
  iAvgMa,
  ageMs: 500,
  stale: false
})

const telem = (nodeId: number, i12: number, i5: number): NodeTelemSnapshot => ({
  nodeId,
  isPdu: true,
  rail12V: rail(TELEM_PAGE.PDU_RAIL_12V, 12_000, i12),
  rail5V: rail(TELEM_PAGE.PDU_RAIL_5V, 5000, i5),
  other: [],
  live: true
})

const summary = (
  nodes: NodeModelEntry[],
  outages: PduOutage[] = [],
  telemetry: NodeTelemSnapshot[] = []
) => {
  const m = model(nodes, outages)
  return nodesSummary(
    nodeViews(m, telemetry),
    outages,
    [],
    boardZones(m.nodes, cockpitMembers(m).get),
    true
  )
}

const T = 1_760_000_000_000

describe('nodesSummary counts', () => {
  const s = summary(
    [
      pdu(3, 'Left'),
      pdu(4, 'Right', { readings: 'none' }),
      node(1),
      node(2, { status: status(2, { degraded: true }) }),
      node(5, { availability: 'offline', offlineAt: T }),
      node(6, { status: status(6, { boff: true }) }),
      node(41, { source: 'new' }),
      pdu(42, 'Left', { source: 'new' })
    ],
    [],
    [telem(3, 1000, 500), telem(42, 1000, 500)]
  )

  it('counts known nodes as healthy / warning / offline, as the Cockpit band does', () => {
    // bus-off reads as offline; new nodes are not counted
    expect([s.known, s.healthy, s.warn, s.off, s.unknown]).toEqual([6, 3, 1, 2, 0])
  })

  it('counts PDUs by their kind and sums W over placed PDUs with readings', () => {
    expect(s.pdus).toBe(2)
    expect(s.watts).toBeCloseTo(12 + 2.5)
  })

  it('has no W when no PDU has readings', () => {
    expect(summary([pdu(3, 'Left', { readings: 'none' }), node(1)]).watts).toBeNull()
  })

  it('never counts a NODE_ID as a PDU unless its kind says so', () => {
    expect(summary([node(1), node(2), node(3)]).pdus).toBe(0)
  })

  it('counts nodes with no status yet apart, and says so in the footer', () => {
    const u = summary([node(1, { availability: 'unknown', status: undefined }), node(2)])
    expect([u.healthy, u.unknown]).toEqual([1, 1])
    expect(u.footer).toBe('1 no status yet · healthy nodes hidden')
  })
})

describe('nodesSummary strays (D1 / X3)', () => {
  it('counts a stray as the Cockpit band does — one up, one warning — with its Attention row', () => {
    const m = model([node(1), node(41, { name: 'Node 41', source: 'new', identified: 'bridge' })])
    const views = nodeViews(m, [])
    const zones = boardZones(m.nodes, cockpitMembers(m).get)
    const strays = [{ nodeId: 41, flag: 'SECOND GATEWAY · can’t be adopted' }]
    const before = nodesSummary(views, [], [], zones, true)
    expect([before.known, before.healthy, before.warn, before.rows.length]).toEqual([1, 1, 0, 0])
    const s = nodesSummary(views, [], strays, zones, true)
    expect([s.known, s.healthy, s.warn, s.off]).toEqual([2, 1, 1, 0])
    expect(s.rows).toEqual([
      {
        nodeId: 41,
        name: 'NODE_ID 41',
        state: 'warn',
        chip: 'SECOND GATEWAY · can’t be adopted',
        tone: 'warn',
        meta: '#41'
      }
    ])
  })
})

describe('nodesSummary rows', () => {
  it('a board not seen this session: no false "offline since", but when it was last seen (#93)', () => {
    const t = Date.UTC(2026, 9, 14, 21, 13)
    const s = summary([
      pdu(4, 'Right', { availability: 'online' }),
      node(34, {
        name: 'Right_TACAN',
        pduId: 4,
        availability: 'offline',
        notSeen: true,
        lastSeenAt: t
      })
    ])
    expect(s.rows.map((r) => [r.chip, r.meta])).toEqual([
      ['OFFLINE', `#34 · PDU_Right · not seen this session · last seen ${lastSeenLabel(t)}`]
    ])
  })

  it('names the feeding PDU and when the client learned the node went offline', () => {
    const s = summary([
      pdu(3, 'Left'),
      node(13, { name: 'Left_Oxygen', pduId: 3, availability: 'offline', offlineAt: T }),
      node(14, { pduId: null, status: status(14, { degraded: true }) })
    ])
    expect(s.rows.map((r) => r.meta)).toEqual([
      `#13 · PDU_Left · offline since ${fmtTime(T).slice(0, 8)}`,
      '#14 · no power zone'
    ])
  })

  it('names a hidden feeding PDU: it is still in your cockpit (X1), marked "(hidden)"', () => {
    const m = {
      ...model([
        node(13, { name: 'Left_Oxygen', pduId: 3, availability: 'offline', offlineAt: T })
      ]),
      hidden: [3],
      hiddenNodes: [
        { nodeId: 3, name: 'PDU_Left', console: 'Left', kind: 'pdu', source: 'registry' } as const
      ]
    }
    const meta = (mem: ReturnType<typeof cockpitMembers>) =>
      nodesSummary(nodeViews(m, []), [], [], boardZones(m.nodes, mem.get), true).rows.map(
        (r) => r.meta
      )
    expect(meta(cockpitMembers(m))).toEqual([
      `#13 · PDU_Left (hidden) · offline since ${fmtTime(T).slice(0, 8)}`
    ])
    // Read from the plan's boards alone it would be "no power zone": the test can fail.
    expect(meta(cockpitMembers(model([])))).toEqual([
      `#13 · no power zone · offline since ${fmtTime(T).slice(0, 8)}`
    ])
  })

  it('folds a PDU outage into one row for the PDU', () => {
    const o: PduOutage = { pduId: 6, nodeIds: [7, 8], fedCount: 2, at: T }
    const s = summary(
      [
        pdu(6, 'Center', { availability: 'offline', offlineAt: T }),
        node(7, { pduId: 6, availability: 'offline', offlineAt: T }),
        node(8, { pduId: 6, availability: 'offline', offlineAt: T })
      ],
      [o]
    )
    expect(s.rows).toHaveLength(1)
    expect(s.rows[0]).toMatchObject({
      nodeId: 6,
      name: 'PDU_Center',
      chip: 'OFFLINE',
      tone: 'err',
      meta: `#6 · 2 nodes affected · offline since ${fmtTime(T).slice(0, 8)}`
    })
    // every node still counts as offline
    expect(s.off).toBe(3)
    expect(s.footer).toBe('')
  })

  it('has no rows and only the hidden-healthy note when all is well', () => {
    const s = summary([node(1), pdu(3, 'Left')])
    expect([s.rows, s.more, s.footer]).toEqual([[], 0, 'healthy nodes hidden'])
  })
})

describe('nodesSummary with no board of your cockpit (#160)', () => {
  const panelNew = (nodeId: number) => node(nodeId, { source: 'new', identified: 'panel' })

  it('points to the new boards on the bus — the Overview notice’s count — and where to add them', () => {
    const one = summary([panelNew(41)])
    expect([one.known, one.newCount]).toEqual([0, 1])
    expect(one.empty).toBe('1 new board on the bus — add it from the Cockpit.')
    const two = summary([panelNew(41), pdu(42, 'Left', { source: 'new', identified: 'pdu' })])
    expect(two.newCount).toBe(2)
    expect(two.empty).toBe('2 new boards on the bus — add them from the Cockpit.')
  })

  it('says the bus reports nothing only when it does: none on it, or none identified yet', () => {
    expect(summary([]).empty).toBe('No nodes reported. Power on a PanelGroup.')
    // Still identifying: not news yet (isReportableNew), so not counted.
    const s = summary([node(41, { source: 'new' })])
    expect([s.newCount, s.empty]).toEqual([0, 'No nodes reported. Power on a PanelGroup.'])
  })
})
