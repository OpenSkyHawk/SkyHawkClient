import { describe, expect, it } from 'vitest'
import type { NodeModelEntry, NodeTelemSnapshot, PduOutage } from '@shared/nodes/ipc'
import {
  modelNode as node,
  nodeModel as model,
  nodeStatus as status
} from '../../test-fixtures/nodes'
import { TELEM_PAGE } from '@shared/node-telem'
import { attentionItems, healthBand, nodeViews } from './cockpit'
import { attentionSummary, cockpitTile, newDevices, newDevicesText, reportedKind } from './overview'

const pdu = (nodeId: number, over: Partial<NodeModelEntry> = {}) =>
  node(nodeId, {
    name: `PDU_${nodeId}`,
    kind: 'pdu',
    readings: 'live',
    everHadReadings: true,
    ...over
  })

/** A new NODE_ID as the model has it: 'panel' unless it sent PDU pages (not a reported kind). */
const fresh = (nodeId: number, over: Partial<NodeModelEntry> = {}) =>
  node(nodeId, { name: `Node ${nodeId}`, console: null, source: 'new', ...over })

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

const bandOf = (nodes: NodeModelEntry[], telemetry: NodeTelemSnapshot[] = []) =>
  healthBand(nodeViews(model(nodes), telemetry))

describe('cockpitTile', () => {
  it('shows nodes up / known, the client-computed total W and the PDUs on the plan', () => {
    const band = bandOf([pdu(3), pdu(4), node(1), node(2)], [telem(3, 3000, 500)])
    expect(cockpitTile(band, true)).toEqual({
      value: '4 / 4',
      sub: 'nodes up · 38.5 W · 2 PDUs',
      symbol: undefined,
      tone: 'ok'
    })
  })

  it('carries the worst symbol: offline before warning', () => {
    const warn = bandOf([node(1, { status: status(1, { epvf: true }) }), node(2)])
    expect(cockpitTile(warn, true)).toMatchObject({ value: '2 / 2', symbol: 'warn', tone: 'issue' })
    const off = bandOf([
      node(1, { status: status(1, { epvf: true }) }),
      node(2, { availability: 'offline' })
    ])
    expect(cockpitTile(off, true)).toMatchObject({ value: '1 / 2', symbol: 'off', tone: 'issue' })
  })

  it('says "— W" without PDU readings and leaves out a PDU count of 0', () => {
    expect(cockpitTile(bandOf([node(1)]), true).sub).toBe('nodes up · — W')
    expect(cockpitTile(bandOf([pdu(3, { readings: 'none' }), node(1)]), true).sub).toBe(
      'nodes up · — W · 1 PDU'
    )
  })

  it('does not count new NODE_IDs (they wait in the notice)', () => {
    const band = bandOf([node(1), fresh(41), fresh(42, { kind: 'pdu', everHadReadings: true })])
    expect(cockpitTile(band, true).value).toBe('1 / 1')
  })

  it('has no live value while the link is down', () => {
    expect(cockpitTile(bandOf([node(1)]), false)).toEqual({
      value: '—',
      sub: 'no live node status',
      tone: 'none'
    })
  })

  it('has no value before any status arrives, and stays neutral while some is missing', () => {
    const none = bandOf([node(1, { availability: 'unknown', status: undefined })])
    expect(cockpitTile(none, true)).toEqual({ value: '—', sub: 'no status yet', tone: 'none' })
    const some = bandOf([node(1), node(2, { availability: 'unknown', status: undefined })])
    expect(cockpitTile(some, true)).toMatchObject({ value: '1 / 2', tone: 'none' })
    expect(cockpitTile(bandOf([]), true)).toMatchObject({ value: '—', sub: 'no nodes known' })
  })

  it('takes NODE_ID 0 like any other node', () => {
    expect(cockpitTile(bandOf([node(0), node(1)]), true).value).toBe('2 / 2')
  })
})

describe('attentionSummary', () => {
  const summary = (nodes: NodeModelEntry[], outages: PduOutage[] = []) => {
    const views = nodeViews(model(nodes, outages), [])
    return attentionSummary(healthBand(views), attentionItems(views, outages))
  }
  const warn = (id: number) => node(id, { status: status(id, { epvf: true }) })
  const off = (id: number) => node(id, { availability: 'offline' })

  it('is null while no board reports a problem', () => {
    expect(summary([node(1), fresh(41)])).toBeNull()
    expect(summary([node(1, { availability: 'unknown', status: undefined })])).toBeNull()
  })

  it('counts and names the offline nodes first, then counts the warnings', () => {
    expect(summary([off(4), warn(1), off(2), warn(3)])).toEqual({
      head: '4 nodes need attention',
      detail: '2 offline (Node_2, Node_4) · 2 warnings'
    })
  })

  it('names the warnings when nothing is offline', () => {
    expect(summary([warn(1)])).toEqual({
      head: '1 node needs attention',
      detail: '1 warning (Node_1)'
    })
  })

  it('names three, then "+N more"', () => {
    expect(summary([off(1), off(2), off(3), off(4), off(5)])!.detail).toBe(
      '5 offline (Node_1, Node_2, Node_3 +2 more)'
    )
  })

  it('counts every node in a PDU outage and names it as the PDU plus its nodes', () => {
    const o: PduOutage = { pduId: 6, nodeIds: [7, 8], fedCount: 2, at: 1 }
    const nodes = [
      pdu(6, { availability: 'offline', readings: undefined }),
      node(7, { pduId: 6, availability: 'offline' }),
      node(8, { pduId: 6, availability: 'offline' }),
      off(2)
    ]
    expect(summary(nodes, [o])).toEqual({
      head: '4 nodes need attention',
      detail: '4 offline (PDU_6 + 2 nodes, Node_2)'
    })
  })

  it('treats NODE_ID 0 like any other node', () => {
    expect(summary([off(0)])!.detail).toBe('1 offline (Node_0)')
  })
})

describe('reportedKind', () => {
  it('is what the shared resolver identified, never the display kind or the NODE_ID', () => {
    expect(reportedKind(fresh(42, { kind: 'pdu', identified: 'pdu' }))).toBe('pdu')
    expect(reportedKind(fresh(44, { identified: 'panel' }))).toBe('panel')
    // The model files a new node under 'panel' by default: that is not a reported kind.
    expect(reportedKind(fresh(41))).toBeNull()
    expect(reportedKind(fresh(43, { kind: 'pdu' }))).toBeNull()
    // A bridge, or a kind this client doesn't know, is not something to adopt.
    expect(reportedKind(fresh(45, { identified: 'bridge' }))).toBeNull()
    expect(reportedKind(fresh(46, { identified: 'other' }))).toBeNull()
  })
})

describe('newDevices', () => {
  const views = (nodes: NodeModelEntry[]) => nodeViews(model(nodes), [])
  const newPdu = (id: number, over: Partial<NodeModelEntry> = {}) =>
    fresh(id, { kind: 'pdu', identified: 'pdu', everHadReadings: true, ...over })

  it('is null when no NODE_ID waits to be adopted', () => {
    expect(newDevices(views([node(1), pdu(3)]), true)).toBeNull()
  })

  it('counts identified new NODE_IDs only; an unidentified one is not mentioned', () => {
    expect(newDevices(views([node(1), fresh(0), fresh(41), newPdu(42)]), true)).toEqual({
      count: 1,
      panels: 0,
      pdus: 1,
      registry: 0
    })
  })

  it('is null while every new NODE_ID is still unidentified', () => {
    expect(newDevices(views([fresh(41), fresh(43, { kind: 'pdu' })]), true)).toBeNull()
  })

  it('leaves out an identified node that has left the bus', () => {
    expect(newDevices(views([newPdu(42, { availability: 'offline' })]), true)).toBeNull()
    expect(newDevices(views([newPdu(42, { availability: 'offline' }), newPdu(44)]), true)).toEqual({
      count: 1,
      panels: 0,
      pdus: 1,
      registry: 0
    })
  })

  it('is null while the link is down', () => {
    expect(newDevices(views([newPdu(42)]), false)).toBeNull()
  })
})

describe('newDevicesText', () => {
  it('lists the reported kinds', () => {
    expect(newDevicesText({ count: 1, panels: 0, pdus: 1, registry: 0 })).toEqual({
      head: '1 new device on the bus',
      detail: '1 PDU, not in NODE_IDS.md.'
    })
    expect(newDevicesText({ count: 3, panels: 1, pdus: 2, registry: 0 })).toEqual({
      head: '3 new devices on the bus',
      detail: '1 panel group, 2 PDUs, not in NODE_IDS.md.'
    })
  })

  it('a registry board waiting to be added is from NODE_IDS.md, not "not in" it (#93)', () => {
    expect(newDevicesText({ count: 1, panels: 1, pdus: 0, registry: 1 }).detail).toBe(
      '1 panel group from NODE_IDS.md, not added to your cockpit yet.'
    )
    expect(newDevicesText({ count: 3, panels: 2, pdus: 1, registry: 2 }).detail).toBe(
      '2 panel groups, 1 PDU, not added to your cockpit yet — 2 from NODE_IDS.md.'
    )
  })

  it('counts the registry boards among them', () => {
    const reg = fresh(1, {
      identified: 'panel',
      registry: { name: 'Center_Armament', console: 'Center', pduId: 5 }
    })
    expect(newDevices(nodeViews(model([reg]), []), true)).toEqual({
      count: 1,
      panels: 1,
      pdus: 0,
      registry: 1
    })
  })
})
