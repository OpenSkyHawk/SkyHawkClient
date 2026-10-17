// Ported from the renderer (R3.2): the Adopt dialog's queue, evidence,
// adoptability, pre-fill and PDU choices, and the strays, now built in main. Same cases, same
// expected values.
import { describe, expect, it } from 'vitest'
import type { NodeModelEntry, NodeStatus, NodeTelemSnapshot } from '@shared/nodes'
import { modelNode, nodeModel as model, nodeStatus } from '../../../test-fixtures/nodes'
import { TELEM_PAGE } from '../node-telem'
import { adoptEvidence, adoptability, adoptQueue, adoptRows, prefill } from './adopt'
import { strayFlag, strayNew } from './attention'
import { cockpitMembers } from './members'
import { powerZoneOptions } from './panels'
import { nodeViews } from './views'

const status = (nodeId: number, over: Partial<NodeStatus> = {}): NodeStatus =>
  nodeStatus(nodeId, { uptimeSec: 130, ...over })

const fresh = (nodeId: number, over: Partial<NodeModelEntry> = {}): NodeModelEntry =>
  modelNode(nodeId, {
    name: `Node ${nodeId}`,
    console: null,
    source: 'new',
    status: status(nodeId),
    firstSeenAt: 1000,
    ...over
  })

const pduTelem = (nodeId: number): NodeTelemSnapshot => ({
  nodeId,
  isPdu: true,
  rail12V: {
    kind: 'rail',
    page: TELEM_PAGE.PDU_RAIL_12V,
    flags: 0,
    vAvgMv: 12_050,
    vMinMv: 12_000,
    iAvgMa: 20,
    ageMs: 500,
    stale: false
  },
  rail5V: {
    kind: 'rail',
    page: TELEM_PAGE.PDU_RAIL_5V,
    flags: 0,
    vAvgMv: 5020,
    vMinMv: 5000,
    iAvgMa: -5,
    ageMs: 500,
    stale: false
  },
  other: [],
  live: true
})

describe('adoptQueue', () => {
  it('new NODE_IDs only, oldest first seen first, then by NODE_ID', () => {
    const views = nodeViews(
      model([
        fresh(1, { source: 'registry', name: 'Center_Armament', console: 'Center' }),
        fresh(42, { firstSeenAt: 500 }),
        fresh(43, { firstSeenAt: 500 }),
        fresh(41, { firstSeenAt: 2000 }),
        fresh(44, { firstSeenAt: undefined })
      ]),
      []
    )
    expect(adoptQueue(views).map((v) => v.entry.nodeId)).toEqual([42, 43, 41, 44])
  })
})

describe('adoptEvidence', () => {
  it('a panel group it reported: status only, healthy', () => {
    const [v] = nodeViews(
      model([fresh(41, { identified: 'panel', status: status(41, { nodeKind: 1 }) })]),
      []
    )
    expect(adoptEvidence(v!)).toEqual({
      detected: 'panel group (reported by the board)',
      reporting: 'status only · up 00:02:10 · healthy',
      registry: 'not in NODE_IDS.md'
    })
  })

  it('a node that has not reported its kind is "not known yet", never a panel group', () => {
    const [v] = nodeViews(model([fresh(41)]), [])
    expect(adoptEvidence(v!).detected).toBe('not known yet')
  })

  it('names the faults it reports', () => {
    const [v] = nodeViews(
      model([
        fresh(41, {
          status: status(41, { degraded: true, faultId: 1, faultAbbr: 'I2C', epvf: true })
        })
      ]),
      []
    )
    expect(adoptEvidence(v!).reporting).toBe('status only · up 00:02:10 · I2C, error-passive')
  })

  it('a PDU shows its fresh telemetry; negative offset reads 0 A', () => {
    const [v] = nodeViews(model([fresh(42, { kind: 'pdu', identified: 'pdu' })]), [pduTelem(42)])
    expect(adoptEvidence(v!)).toMatchObject({
      detected: 'PDU (PDU telemetry seen)',
      reporting: 'telemetry: 12 V 12.05 V · 0.02 A, 5 V 5.02 V · 0.00 A'
    })
  })

  it('a PDU without fresh pages falls back to its status', () => {
    const [v] = nodeViews(model([fresh(42, { kind: 'pdu' })]), [])
    expect(adoptEvidence(v!).reporting).toMatch(/^status only/)
  })

  it('says so when it is not reporting', () => {
    const [v] = nodeViews(model([fresh(41, { availability: 'offline' })]), [])
    expect(adoptEvidence(v!).reporting).toBe('not reporting right now')
  })
})

describe('adoptability', () => {
  it('only a PDU or a panel group can be adopted', () => {
    expect(adoptability(fresh(42, { identified: 'pdu' }))).toEqual({ kind: 'pdu', badge: 'PDU' })
    expect(adoptability(fresh(41, { identified: 'panel' }))).toEqual({
      kind: 'panel',
      badge: 'PANEL GROUP'
    })
  })

  it('still identifying: no kind, an "Identifying…" note', () => {
    expect(adoptability(fresh(41))).toEqual({
      badge: 'IDENTIFYING',
      note: 'Identifying… waiting for the board to report its type. If it doesn’t within a few seconds, it shows in Attention as an issue.'
    })
  })

  it('a bridge or a kind this client does not know: no kind, and says why', () => {
    const bridge = adoptability(fresh(43, { identified: 'bridge' }))
    expect(bridge).toMatchObject({ badge: 'BRIDGE' })
    expect(bridge.kind).toBeUndefined()
    expect(bridge.note).toMatch(/Gateway/)
    const other = adoptability(
      fresh(44, { identified: 'other', status: status(44, { nodeKind: 7 }) })
    )
    expect(other).toMatchObject({ badge: 'UNKNOWN TYPE' })
    expect(other.note).toMatch(/doesn’t know \(7\)/)
  })
})

// The Powered by list the form reads is the panels' (powerZoneOptions, through zoneChoices): one
// list for the Adopt form and the Settings tab. D7 (#131): only a PDU in your cockpit is a zone, so
// there is no "(not added)" choice any more.
describe('Powered by choices (#93 re-review J; D7)', () => {
  const pduIn = (id: number, console: string, name: string) =>
    fresh(id, { source: 'registry', kind: 'pdu', identified: 'pdu', console, name })
  const m = model([pduIn(5, 'Center', 'PDU_Center'), pduIn(4, 'Right', 'PDU_Right')])
  const members = cockpitMembers(m)
  const board = fresh(1, {
    registry: { name: 'Center_Armament', console: 'Center', pduId: 3 }
  })

  it('a PDU in your cockpit on another console is "(other console)", never "not added"', () => {
    expect(powerZoneOptions(members, 'Center', 4)).toEqual([
      { value: 5, label: 'PDU_Center' },
      { value: 4, label: 'PDU_Right (other console)' }
    ])
  })

  it('a PDU not in your cockpit is never offered; the pre-fill and Add all give None (D7)', () => {
    // PDU_Left (#3) is Center_Armament's NODE_IDS.md default here, but not in your cockpit.
    expect(powerZoneOptions(members, 'Center', 3)).toEqual([{ value: 5, label: 'PDU_Center' }])
    const queued = [
      ...nodeViews(m, []),
      ...nodeViews(model([{ ...board, identified: 'panel' }]), [])
    ]
    const row = adoptRows(queued, members).find((r) => r.view.entry.nodeId === 1)!
    expect(row.prefill.pduId).toBeNull()
    expect(row.addAllPduId).toBeNull()
    expect(row).not.toHaveProperty('pending')
  })

  it('a hidden PDU is in your cockpit: offered as "(hidden)", never "(not added)" (X1, #95 bug 2)', () => {
    // PDU_Left (#3) is in your cockpit, hidden: not on the plan, so not in `views`.
    const hiddenLeft = {
      ...model([pduIn(5, 'Center', 'PDU_Center')]),
      hidden: [3],
      hiddenNodes: [
        { nodeId: 3, name: 'PDU_Left', console: 'Left', kind: 'pdu', source: 'registry' } as const
      ]
    }
    const v = nodeViews(hiddenLeft, [])
    const mem = cockpitMembers(hiddenLeft)
    expect(powerZoneOptions(mem, 'Center', 3)).toEqual([
      { value: 5, label: 'PDU_Center' },
      { value: 3, label: 'PDU_Left (hidden, other console)' }
    ])
    expect(powerZoneOptions(mem, 'Left', 3)).toEqual([{ value: 3, label: 'PDU_Left (hidden)' }])
    // The same board's row, identified as a panel group: the pre-fill and Add all keep its
    // default PDU.
    const queued = [...v, ...nodeViews(model([{ ...board, identified: 'panel' }]), [])]
    const row = (mem2: typeof mem) =>
      adoptRows(queued, mem2).find((r) => r.view.entry.nodeId === 1)!
    expect(row(mem).prefill.pduId).toBe(3)
    expect(row(mem).addAllPduId).toBe(3)
    // Without the hidden PDU, Add all drops the link: the test can fail.
    expect(row(cockpitMembers(model([]))).addAllPduId).toBeNull()
  })
})

describe('registry onboarding (#93)', () => {
  const reg = (id: number, over: Partial<NodeModelEntry> = {}) =>
    fresh(id, {
      name: 'Center_Armament',
      identified: 'panel',
      registry: { name: 'Center_Armament', console: 'Center', pduId: 5 },
      ...over
    })
  /** PDU_Center (#5) in your cockpit: the default PDU the pre-fill may keep (D7). */
  const center = cockpitMembers(
    model([fresh(5, { source: 'registry', kind: 'pdu', console: 'Center', name: 'PDU_Center' })])
  )

  it('pre-fills name, console and default PDU from NODE_IDS.md; a PDU takes no zone', () => {
    expect(prefill(reg(1), 'panel', center)).toEqual({
      name: 'Center_Armament',
      console: 'Center',
      pduId: 5
    })
    const pdu = reg(5, {
      identified: 'pdu',
      registry: { name: 'PDU_Center', console: 'Center', pduId: null }
    })
    expect(prefill(pdu, 'pdu', center)).toEqual({
      name: 'PDU_Center',
      console: 'Center',
      pduId: null
    })
    expect(prefill(fresh(41), 'panel', center)).toEqual({ name: '', console: '', pduId: '' }) // unregistered
  })

  it('pre-fills None when the default PDU is not in your cockpit (D7)', () => {
    expect(prefill(reg(1), 'panel', cockpitMembers(model([])))).toEqual({
      name: 'Center_Armament',
      console: 'Center',
      pduId: null
    })
  })

  it('says where it comes from: what it reported, and its NODE_IDS.md entry', () => {
    const ev = adoptEvidence(
      nodeViews(model([reg(1, { status: status(1, { nodeKind: 1 }) })]), [])[0]!
    )
    expect(ev.detected).toBe('panel group (reported by the board)')
    expect(ev.registry).toBe('NODE_IDS.md: Center_Armament, Instrument panel')
  })
})

describe('strayNew', () => {
  const at = (nodes: NodeModelEntry[]) => nodeViews(model(nodes), [])
  const ids = (r: ReturnType<typeof strayNew>) => r.strays.map((v) => v.entry.nodeId)

  it('waits IDENTIFY_WAIT_MS for an unknown board, and says when the next one is due', () => {
    const views = at([fresh(41, { firstSeenAt: 0 }), fresh(43, { firstSeenAt: 3000 })])
    expect(strayNew(views, 4000, true)).toEqual({ strays: [], nextAt: 5000 })
    const r = strayNew(views, 5000, true)
    expect(ids(r)).toEqual([41])
    expect(r.nextAt).toBe(8000)
    expect(strayNew(views, 8000, true).nextAt).toBeUndefined()
    expect(ids(strayNew(views, 8000, true))).toEqual([41, 43])
  })

  it('takes a bridge or an unknown type at once; never an adoptable or offline node', () => {
    const views = at([
      fresh(44, { identified: 'bridge', firstSeenAt: 1000 }),
      fresh(45, { identified: 'other', firstSeenAt: 1000 }),
      fresh(41, { identified: 'panel', firstSeenAt: 0 }),
      fresh(46, { availability: 'offline', firstSeenAt: 0 })
    ])
    expect(ids(strayNew(views, 1000, true))).toEqual([44, 45])
  })
})

describe('strayFlag', () => {
  it('says what it is and that it can’t be adopted', () => {
    expect(strayFlag(fresh(44, { identified: 'bridge' }))).toBe('SECOND GATEWAY · can’t be adopted')
    expect(strayFlag(fresh(45, { identified: 'other' }))).toBe(
      'UNKNOWN BOARD TYPE · can’t be adopted'
    )
    expect(strayFlag(fresh(43))).toBe('UNIDENTIFIED · can’t be adopted')
  })
})
