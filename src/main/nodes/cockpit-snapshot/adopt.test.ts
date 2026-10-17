// Ported from the renderer's cockpit-adopt.test.ts (R3.2): the Adopt dialog's queue, evidence,
// adoptability, pre-fill and PDU choices, and the strays, now built in main. Same cases, same
// expected values.
import { describe, expect, it } from 'vitest'
import type { NodeModelEntry, NodeStatus, NodeTelemSnapshot } from '@shared/nodes'
import { modelNode, nodeModel as model, nodeStatus } from '../../../test-fixtures/nodes'
import { TELEM_PAGE } from '../node-telem'
import { adoptEvidence, adoptPduChoices, adoptability, adoptQueue, prefill } from './adopt'
import { strayFlag, strayNew } from './attention'
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

describe('adoptPduChoices (#93 re-review J)', () => {
  const pduIn = (id: number, console: string, name: string) =>
    fresh(id, { source: 'registry', kind: 'pdu', identified: 'pdu', console, name })
  const views = nodeViews(
    model([pduIn(5, 'Center', 'PDU_Center'), pduIn(4, 'Right', 'PDU_Right')]),
    []
  )
  const board = fresh(1, {
    registry: { name: 'Center_Armament', console: 'Center', pduId: 3, pduName: 'PDU_Left' }
  })

  it('a PDU in your cockpit on another console is "(other console)", never "not added"', () => {
    expect(adoptPduChoices(views, 'Center', 4, board)).toEqual({
      zones: [
        { value: 5, label: 'PDU_Center' },
        { value: 4, label: 'PDU_Right (other console)' }
      ]
    })
  })

  it('only a PDU not in your cockpit at all is pending ("not added"), by its registry name', () => {
    expect(adoptPduChoices(views, 'Center', 3, board).pending).toBe('PDU_Left')
    expect(adoptPduChoices(views, 'Center', 5, board).pending).toBeUndefined()
    expect(adoptPduChoices(views, 'Center', null, board).pending).toBeUndefined()
  })
})

describe('registry onboarding (#93)', () => {
  const reg = (id: number, over: Partial<NodeModelEntry> = {}) =>
    fresh(id, {
      name: 'Center_Armament',
      identified: 'panel',
      registry: { name: 'Center_Armament', console: 'Center', pduId: 5, pduName: 'PDU_Center' },
      ...over
    })

  it('pre-fills name, console and default PDU from NODE_IDS.md; a PDU takes no zone', () => {
    expect(prefill(reg(1), 'panel')).toEqual({
      name: 'Center_Armament',
      console: 'Center',
      pduId: 5
    })
    const pdu = reg(5, {
      identified: 'pdu',
      registry: { name: 'PDU_Center', console: 'Center', pduId: null }
    })
    expect(prefill(pdu, 'pdu')).toEqual({ name: 'PDU_Center', console: 'Center', pduId: null })
    expect(prefill(fresh(41), 'panel')).toEqual({ name: '', console: '', pduId: '' }) // unregistered
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
    expect(strayNew(views, 4000)).toEqual({ strays: [], nextAt: 5000 })
    const r = strayNew(views, 5000)
    expect(ids(r)).toEqual([41])
    expect(r.nextAt).toBe(8000)
    expect(strayNew(views, 8000).nextAt).toBeUndefined()
    expect(ids(strayNew(views, 8000))).toEqual([41, 43])
  })

  it('takes a bridge or an unknown type at once; never an adoptable or offline node', () => {
    const views = at([
      fresh(44, { identified: 'bridge', firstSeenAt: 1000 }),
      fresh(45, { identified: 'other', firstSeenAt: 1000 }),
      fresh(41, { identified: 'panel', firstSeenAt: 0 }),
      fresh(46, { availability: 'offline', firstSeenAt: 0 })
    ])
    expect(ids(strayNew(views, 1000))).toEqual([44, 45])
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
