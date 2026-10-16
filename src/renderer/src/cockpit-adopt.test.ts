import { describe, expect, it } from 'vitest'
import type { NodeModel, NodeModelEntry } from '@shared/node-rules'
import type { NodeStatus } from '@shared/nodes'
import { TELEM_PAGE, type NodeTelemSnapshot } from '@shared/node-telem'
import { nodeViews } from './cockpit'
import {
  adoptEvidence,
  adoptability,
  adoptQueue,
  adoptSpec,
  identState,
  nextSelection,
  seenAgo,
  unidentifiedNew
} from './cockpit-adopt'

const status = (nodeId: number, over: Partial<NodeStatus> = {}): NodeStatus => ({
  nodeId,
  present: true,
  boff: false,
  epvf: false,
  uptimeSec: 130,
  rxCount: 10,
  tec: 0,
  rec: 0,
  dieTempC: 30,
  overheat: false,
  degraded: false,
  faultId: 0,
  nodeKind: 0,
  ...over
})

const fresh = (nodeId: number, over: Partial<NodeModelEntry> = {}): NodeModelEntry => ({
  nodeId,
  name: `Node ${nodeId}`,
  console: null,
  pduId: null,
  kind: 'panel',
  source: 'new',
  availability: 'online',
  seenOnline: true,
  status: status(nodeId),
  firstSeenAt: 1000,
  differs: false,
  ...over
})

const model = (nodes: NodeModelEntry[]): NodeModel => ({
  nodes,
  outages: [],
  differingCount: 0,
  ignored: [],
  ignoredNodes: [],
  hidden: [],
  hiddenNodes: [],
  rosterComplete: true
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

describe('seenAgo', () => {
  it('says how long ago this session first saw it', () => {
    expect(seenAgo(0, 30_000)).toBe('first seen just now')
    expect(seenAgo(0, 2 * 60_000 + 5_000)).toBe('first seen 2 min ago')
    expect(seenAgo(0, 3 * 3_600_000)).toBe('first seen 3 h ago')
    expect(seenAgo(undefined, 0)).toBe('first seen this session')
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

describe('adoptSpec', () => {
  it('incomplete until name, console and (for a panel) powered-by are set', () => {
    expect(adoptSpec('panel', { name: ' ', console: 'Left', pduId: 3 })).toBeNull()
    expect(adoptSpec('panel', { name: 'Left_Lights', console: '', pduId: 3 })).toBeNull()
    expect(adoptSpec('panel', { name: 'Left_Lights', console: 'Left', pduId: '' })).toBeNull()
  })

  it('a panel takes its PDU, or None', () => {
    expect(adoptSpec('panel', { name: ' Left_Lights ', console: 'Left', pduId: 3 })).toEqual({
      name: 'Left_Lights',
      console: 'Left',
      pduId: 3,
      kind: 'panel'
    })
    expect(adoptSpec('panel', { name: 'Spare', console: 'Right', pduId: null })?.pduId).toBeNull()
  })

  it('a PDU asks only name and console, and never has a power zone', () => {
    expect(adoptSpec('pdu', { name: 'PDU_Aft', console: 'Right', pduId: '' })).toEqual({
      name: 'PDU_Aft',
      console: 'Right',
      pduId: null,
      kind: 'pdu'
    })
  })
})

describe('identState', () => {
  it('blue while reporting, red when it drops, green when it is back', () => {
    expect(identState(true, false)).toBe('new')
    expect(identState(false, true)).toBe('off')
    expect(identState(true, true)).toBe('on')
  })
})

describe('nextSelection', () => {
  const order = [41, 42, 43]

  it('after Adopt or Ignore: the one after it, else the first left', () => {
    expect(nextSelection(order, [41, 43], 42, 'done')).toBe(43)
    expect(nextSelection(order, [41, 42], 43, 'done')).toBe(41)
    expect(nextSelection(order, [], 41, 'done')).toBeNull()
  })

  it('Later moves on and keeps it queued; past the end there is nothing', () => {
    expect(nextSelection(order, order, 41, 'later')).toBe(42)
    expect(nextSelection(order, order, 43, 'later')).toBeNull()
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
      note: 'Identifying… waiting for the board to report its type.'
    })
  })

  it('a bridge or a kind this client does not know: no kind, and says why', () => {
    const bridge = adoptability(fresh(43, { identified: 'bridge' }))
    expect(bridge).toMatchObject({ badge: 'BRIDGE' })
    expect(bridge.kind).toBeUndefined()
    expect(bridge.note).toMatch(/SimGateway \/ PanelBridge/)
    const other = adoptability(
      fresh(44, { identified: 'other', status: status(44, { nodeKind: 7 }) })
    )
    expect(other).toMatchObject({ badge: 'UNKNOWN TYPE' })
    expect(other.note).toMatch(/doesn’t know \(7\)/)
  })
})

describe('unidentifiedNew', () => {
  const at = (nodes: NodeModelEntry[]) => nodeViews(model(nodes), [])

  it('counts a node still unknown after the wait, and says when the next one is due', () => {
    const views = at([fresh(41, { firstSeenAt: 0 }), fresh(43, { firstSeenAt: 3000 })])
    expect(unidentifiedNew(views, 4000)).toEqual({ count: 0, nextAt: 5000 })
    expect(unidentifiedNew(views, 5000)).toEqual({ count: 1, nextAt: 8000 })
    expect(unidentifiedNew(views, 8000)).toEqual({ count: 2 })
  })

  it('counts a bridge or an unknown type at once; never an adoptable or offline node', () => {
    const views = at([
      fresh(44, { identified: 'bridge', firstSeenAt: 1000 }),
      fresh(45, { identified: 'other', firstSeenAt: 1000 }),
      fresh(41, { identified: 'panel', firstSeenAt: 0 }),
      fresh(46, { availability: 'offline', firstSeenAt: 0 })
    ])
    expect(unidentifiedNew(views, 1000)).toEqual({ count: 2 })
  })
})
