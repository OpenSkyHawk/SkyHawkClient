// The Adopt dialog's own state (adopt-view.ts, R3.2): the form and the
// spec it sends, the rows kept while it is open, the identify dot, the next selection and "Add all".
// The rows themselves are main's (adoptRows), built here from the same views.
import { describe, expect, it } from 'vitest'
import type { AdoptForm, NodeModelEntry, NodeStatus, NodeView } from '@shared/nodes'
import { modelNode, nodeModel as model, nodeStatus } from '../../../test-fixtures/nodes'
import { seenAgo } from '@shared/format'
import { adoptRows } from '../../../main/nodes/cockpit-snapshot/adopt'
import { cockpitMembers } from '../../../main/nodes/cockpit-snapshot/members'
import { nodeViews } from '../../../main/nodes/cockpit-snapshot/views'
import { adoptSpec, identState, keptQueue, nextSelection, registrySpecs } from './adopt-view'

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

/** main's rows for these views, your cockpit being the boards among them that are not new. */
const rows = (views: NodeView[]) =>
  adoptRows(views, cockpitMembers(model(views.map((v) => v.entry))))

/**
 * "Add all" over main's rows: the boards waiting in `queue`, each checked against the boards in your
 * cockpit in `views` (registrySpecs(queue, views, edits) before R3.2).
 */
const specs = (queue: NodeView[], views: NodeView[], edits?: ReadonlyMap<number, AdoptForm>) =>
  registrySpecs(rows([...views.filter((v) => v.entry.source !== 'new'), ...queue]), edits)

describe('seenAgo', () => {
  it('says how long ago this session first saw it', () => {
    expect(seenAgo(0, 30_000)).toBe('first seen just now')
    expect(seenAgo(0, 2 * 60_000 + 5_000)).toBe('first seen 2 min ago')
    expect(seenAgo(0, 3 * 3_600_000)).toBe('first seen 3 h ago')
    expect(seenAgo(undefined, 0)).toBe('first seen this session')
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

describe('keptQueue (#93 re-review)', () => {
  const at = (nodes: NodeModelEntry[]) => rows(nodeViews(model(nodes), []))
  const ids = (q: ReturnType<typeof keptQueue>) =>
    q.map((r) => [r.view.entry.nodeId, r.view.entry.availability])

  it('keeps a row it showed that dropped out of the model — offline, in its place', () => {
    const first = at([fresh(1, { firstSeenAt: 0 }), fresh(41, { firstSeenAt: 500 })])
    const shown = new Map(first.map((r) => [r.view.entry.nodeId, r]))
    // Board 1 is power-cycled: a registry board not added leaves the model while it is off.
    const now = at([fresh(41, { firstSeenAt: 500 })])
    expect(ids(keptQueue(now, shown, new Set()))).toEqual([
      [1, 'offline'],
      [41, 'online']
    ])
    // It comes back: live again.
    expect(ids(keptQueue(first, shown, new Set()))).toEqual([
      [1, 'online'],
      [41, 'online']
    ])
  })

  it('drops a row once it was added, whether it is still in the model or not', () => {
    const live = at([fresh(1), fresh(41)])
    const shown = new Map(live.map((r) => [r.view.entry.nodeId, r]))
    expect(ids(keptQueue(live, shown, new Set([1])))).toEqual([[41, 'online']])
    expect(ids(keptQueue(at([fresh(41)]), shown, new Set([1])))).toEqual([[41, 'online']])
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

  it('"Add all": registry panel groups only, linked only to a PDU already in your cockpit', () => {
    const pduIn = fresh(5, {
      source: 'registry',
      kind: 'pdu',
      identified: 'pdu',
      name: 'PDU_Center'
    })
    const nav = reg(2, {
      name: 'Right_Navigation',
      registry: { name: 'Right_Navigation', console: 'Right', pduId: 4, pduName: 'PDU_Right' }
    })
    const newPdu = reg(3, {
      kind: 'pdu',
      identified: 'pdu',
      registry: { name: 'PDU_Left', console: 'Left', pduId: null }
    })
    const queue = nodeViews(model([reg(1), nav, newPdu, fresh(41, { identified: 'panel' })]), [])
    const views = nodeViews(model([pduIn, reg(1), nav, newPdu]), [])
    expect(specs(queue, views)).toEqual([
      { nodeId: 1, spec: { name: 'Center_Armament', console: 'Center', pduId: 5, kind: 'panel' } },
      // PDU_Right isn't in your cockpit: no silent link.
      {
        nodeId: 2,
        spec: { name: 'Right_Navigation', console: 'Right', pduId: null, kind: 'panel' }
      }
    ]) // the PDU (3) and the unregistered board (41) are added one by one
  })

  it('"Add all" takes a form you changed — None, a name, even a PDU not added', () => {
    const queue = nodeViews(model([reg(1), reg(2, { name: 'Right_Navigation' })]), [])
    const views = nodeViews(
      model([fresh(5, { source: 'registry', kind: 'pdu', name: 'PDU_Center' })]),
      []
    )
    const edits = new Map([
      [1, { name: 'Arm', console: 'Center', pduId: null }], // None, on purpose
      [2, { name: 'Nav', console: 'Right', pduId: 4 }] // its PDU, chosen though not added
    ])
    expect(specs(queue, views, edits).map((b) => [b.nodeId, b.spec.name, b.spec.pduId])).toEqual([
      [1, 'Arm', null],
      [2, 'Nav', 4]
    ])
    // A form left unfinished ("Choose…") is not added in bulk.
    const half = new Map([[1, { name: 'Arm', console: 'Center', pduId: '' as const }]])
    expect(specs(queue, views, half).map((b) => b.nodeId)).toEqual([2])
  })
})
