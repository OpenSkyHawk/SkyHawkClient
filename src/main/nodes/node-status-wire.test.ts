import { describe, expect, it } from 'vitest'
import {
  canRequestRoster,
  cleanNodeLine,
  isLegacyNodeStatus,
  NODE_END_MSG,
  NODE_MSG,
  NodeRoster,
  nodeRosterRequest,
  parseNodeStatus,
  ROSTER_REPLY_MS
} from './node-status-wire'
import { nodeFaultTag } from './faults'
import type { NodeStatus } from '@shared/nodes'
import { nodeStatus, statusRow } from '../../test-fixtures/nodes'

const node = (over: Partial<NodeStatus>): NodeStatus =>
  nodeStatus(1, { uptimeSec: 0, rxCount: 0, ...over })

describe('parseNodeStatus', () => {
  it('decodes a v3 row (28 hex, nodeKind last)', () => {
    // nodeId 03, present 01, flags 02 (EPVF), uptime 000A, rxCount 0003, esr 1100,
    // dieTempC 24 (36 C), hFlags 00, faultMask 00, faultId 00, nodeKind 02 (PDU)
    const ns = parseNodeStatus('030102000A000311002400000002')
    expect(ns).toEqual({
      nodeId: 3,
      present: true,
      boff: false,
      epvf: true,
      uptimeSec: 10,
      rxCount: 3,
      tec: 0x00, // esr low byte
      rec: 0x11, // esr high byte
      dieTempC: 36,
      overheat: false,
      degraded: false,
      faultId: 0,
      nodeKind: 2
    })
  })

  it("decodes the bridge's own row (node 0, kind 03) and passes unknown kinds through", () => {
    expect(parseNodeStatus('0001000000000000008000000003')).toMatchObject({
      nodeId: 0,
      nodeKind: 3
    })
    expect(parseNodeStatus('2901000000000000008000000007')?.nodeKind).toBe(7) // a newer kind
  })

  it('decodes present/removed and the CAN flags', () => {
    expect(parseNodeStatus('0501000000000000008000000000')?.present).toBe(true) // present=01
    expect(parseNodeStatus('0500000000000000008000000000')?.present).toBe(false) // present=00
    expect(parseNodeStatus('0501030000000000008000000000')?.boff).toBe(true) // flags bit0 BOFF
    expect(parseNodeStatus('0501030000000000008000000000')?.epvf).toBe(true) // flags bit1 EPVF
  })

  it('decodes the HEALTH_n telemetry fields', () => {
    // dieTempC 24 = 36 C
    expect(parseNodeStatus('0501000000000000002400000000')?.dieTempC).toBe(36)
    // dieTempC EC = -20 C (int8 two's-complement)
    expect(parseNodeStatus('050100000000000000EC00000000')?.dieTempC).toBe(-20)
    // dieTempC 80 = INT8_MIN sentinel = not-yet-seen => null
    expect(parseNodeStatus('0501000000000000008000000000')?.dieTempC).toBeNull()
    // hFlags bit0 overheat, bit1 degraded
    expect(parseNodeStatus('0501000000000000008001000000')?.overheat).toBe(true)
    expect(parseNodeStatus('0501000000000000008002000000')?.degraded).toBe(true)
    expect(parseNodeStatus('0501000000000000008000000000')?.degraded).toBe(false)
    // faultId passes through (last byte)
    expect(parseNodeStatus('0501000000000000008002000A00')?.faultId).toBe(0x0a)
  })

  it('rejects malformed input', () => {
    expect(parseNodeStatus('zzzz')).toBeNull()
    expect(parseNodeStatus('010100000000000080000000')).toBeNull() // 24 chars — wrong length
    expect(parseNodeStatus('05010000000000000080000000')).toBeNull() // 26 chars — a v2 row
    expect(parseNodeStatus('0501000000000000008000000000ab')).toBeNull() // 30 chars
    expect(parseNodeStatus('4001000000000000008000000001')).toBeNull() // nodeId 64
  })

  it('tells a v2 row apart from a corrupt one, so a v2 bridge can be reported', () => {
    expect(isLegacyNodeStatus('05010000000000000080000000')).toBe(true)
    expect(isLegacyNodeStatus('0501000000000000008000000001')).toBe(false) // v3
    expect(isLegacyNodeStatus('zz010000000000000080000000')).toBe(false)
  })

  it('cuts UART noise off the front of a node-status line, and nothing else', () => {
    // Seen on the bench right after a PanelBridge reset: '_\xfe' before the node-0 row.
    expect(cleanNodeLine('_\xfe_NODE_STATUS 0001000000000000008000000000')).toBe(
      '_NODE_STATUS 0001000000000000008000000000'
    )
    expect(cleanNodeLine('_NODE_STATUS 0101000000000000008000000001')).toBe(
      '_NODE_STATUS 0101000000000000008000000001'
    )
    expect(cleanNodeLine('MY_NODE_LAMP 1')).toBe('MY_NODE_LAMP 1') // printable prefix: left alone
    expect(cleanNodeLine('UFC_1 1')).toBe('UFC_1 1')
  })
})

describe('nodeRosterRequest', () => {
  it('encodes a sync+export frame for 0x86FE = 1', () => {
    expect([...nodeRosterRequest()]).toEqual([
      0x55, 0x55, 0x55, 0x55, 0xfe, 0x86, 0x02, 0x00, 0x01, 0x00
    ])
  })
})

describe('canRequestRoster (the poll, its re-ask and the seed on connect)', () => {
  it('only with a port held and the link up', () => {
    expect(canRequestRoster(true, 'connected')).toBe(true)
    expect(canRequestRoster(false, 'connected'), 'released at shutdown').toBe(false)
    for (const s of ['scanning', 'reconnecting', 'no-device', 'error', 'disconnected'] as const) {
      expect(canRequestRoster(true, s), s).toBe(false)
    }
  })
})

describe('NodeRoster', () => {
  it('keeps a removed node, marked offline', () => {
    const r = new NodeRoster()
    r.applyMessage(NODE_MSG, '0101000000000000008000000000') // node 1 present
    r.applyMessage(NODE_MSG, '0201000000000000008000000000') // node 2 present
    expect(r.snapshot().map((n) => n.nodeId)).toEqual([1, 2])
    r.applyMessage(NODE_MSG, '0100000000000000008000000000') // node 1 removed (present=00)
    expect(r.snapshot().map((n) => [n.nodeId, n.present])).toEqual([
      [1, false],
      [2, true]
    ])
  })

  it('marks nodes absent from a completed burst offline (but keeps them)', () => {
    const r = new NodeRoster()
    r.applyMessage(NODE_MSG, '0101000000000000008000000000') // node 1 present
    r.takeDirty()
    // a fresh roster request returns only node 3, then END
    r.beginBurst() // client sends the request → isolate the reply burst
    r.applyMessage(NODE_MSG, '0301000000000000008000000000')
    r.applyMessage(NODE_END_MSG, '1')
    expect(r.snapshot().map((n) => [n.nodeId, n.present])).toEqual([
      [1, false], // went silent → offline, still listed
      [3, true]
    ])
    expect(r.takeDirty()).toBe(true)
  })

  it('records first-seen, the last report, and when / how a node went offline', () => {
    const r = new NodeRoster()
    r.applyMessage(NODE_MSG, '0101000000000000008000000000', 1000)
    expect(r.seenInfo().get(1)).toEqual({ firstSeenAt: 1000, reportedAt: 1000 })
    r.applyMessage(NODE_MSG, '0100000000000000008000000000', 5000) // live delta: offline
    expect(r.seenInfo().get(1)).toEqual({
      firstSeenAt: 1000,
      reportedAt: 1000, // its last report stays: "last report N s ago"
      offlineAt: 5000,
      offlineVia: 'delta'
    })
    r.applyMessage(NODE_MSG, '0100000000000000008000000000', 6000) // repeat keeps the first time
    expect(r.seenInfo().get(1)?.offlineAt).toBe(5000)
    r.applyMessage(NODE_MSG, '0101000000000000008000000000', 7000)
    expect(r.seenInfo().get(1)).toEqual({ firstSeenAt: 1000, reportedAt: 7000 })
  })

  it('an offline found by a roster reply is marked roster, and the first END is remembered', () => {
    const r = new NodeRoster()
    r.applyMessage(NODE_MSG, '0101000000000000008000000000', 0)
    r.applyMessage(NODE_MSG, '0201000000000000008000000000', 0)
    expect(r.rosterCompleteAt()).toBeUndefined()
    r.beginBurst(3999)
    r.applyMessage(NODE_MSG, '0200000000000000008000000000', 4000) // in the reply, reported absent
    r.applyMessage(NODE_END_MSG, '1', 4001) // node 1 missing from the reply
    expect(r.seenInfo().get(1)).toMatchObject({ offlineAt: 4001, offlineVia: 'roster' })
    expect(r.seenInfo().get(2)).toMatchObject({ offlineAt: 4000, offlineVia: 'roster' })
    expect(r.rosterCompleteAt()).toBe(4001)
    r.beginBurst()
    r.applyMessage(NODE_END_MSG, '0', 9000)
    expect(r.rosterCompleteAt()).toBe(4001) // the first complete roster, not the latest
    r.reset()
    expect(r.rosterCompleteAt()).toBeUndefined()
    expect(r.seenInfo().size).toBe(0)
  })

  it('a reply that never ends does not turn later deltas into roster finds', () => {
    const r = new NodeRoster()
    r.applyMessage(NODE_MSG, '0101000000000000008000000000', 0)
    r.applyMessage(NODE_MSG, '0201000000000000008000000000', 0)
    r.beginBurst(1000) // the bridge never answers with _NODE_STATUS_END
    r.applyMessage(NODE_MSG, '0100000000000000008000000000', 1000 + ROSTER_REPLY_MS)
    expect(r.seenInfo().get(1)?.offlineVia).toBe('roster') // inside the reply window
    r.applyMessage(NODE_MSG, '0200000000000000008000000000', 1001 + ROSTER_REPLY_MS)
    expect(r.seenInfo().get(2)?.offlineVia).toBe('delta') // after it: a live delta
    expect(r.rosterCompleteAt()).toBeUndefined() // registry nodes stay unknown, honestly
  })
})

describe('NodeRoster — a new request never cuts a reply short (M2)', () => {
  const row = (id: number) => statusRow(id, true, id === 0 ? 3 : 1)
  /** One v3 reply's lines: the bridge's node-0 row first, then a row per board. */
  const reply = (r: NodeRoster, ids: number[], t: number) => {
    for (const id of [0, ...ids]) r.applyMessage(NODE_MSG, row(id), t)
  }
  const states = (r: NodeRoster) =>
    r
      .snapshot()
      .filter((n) => n.nodeId !== 0)
      .map((n) => [n.nodeId, n.present])

  it('a reply arriving across a new request is kept: no board reads offline', () => {
    const r = new NodeRoster()
    r.beginBurst(0) // the first poll's roster: boards 1, 2 and 3
    reply(r, [1, 2, 3], 10)
    r.applyMessage(NODE_END_MSG, '4', 10)
    r.beginBurst(5000) // the next poll
    reply(r, [1], 5010)
    r.beginBurst(5011) // a request lands while that reply is still arriving
    r.applyMessage(NODE_MSG, row(2), 5012)
    r.applyMessage(NODE_MSG, row(3), 5013)
    r.applyMessage(NODE_END_MSG, '4', 5014)
    expect(states(r)).toEqual([
      [1, true],
      [2, true],
      [3, true]
    ])
    for (const id of [1, 2, 3]) expect(r.seenInfo().get(id)?.offlineAt, `${id}`).toBeUndefined()
  })

  it('replies queued behind each other: a request in the second one keeps it whole', () => {
    const r = new NodeRoster()
    r.beginBurst(0)
    r.beginBurst(1000) // asked again before the first reply came
    reply(r, [1, 2], 1500) // the first reply, whole
    r.applyMessage(NODE_END_MSG, '3', 1500)
    reply(r, [1], 1510) // the second reply starts
    r.beginBurst(1520) // and the next request lands inside it
    r.applyMessage(NODE_MSG, row(2), 1530)
    r.applyMessage(NODE_END_MSG, '3', 1530)
    expect(states(r)).toEqual([
      [1, true],
      [2, true]
    ])
    expect(r.seenInfo().get(1)?.offlineAt).toBeUndefined()
  })

  it('a board missing from a whole reply is still offline by it', () => {
    const r = new NodeRoster()
    r.beginBurst(0)
    reply(r, [1, 2], 1)
    r.applyMessage(NODE_END_MSG, '3', 1)
    r.beginBurst(5000)
    r.beginBurst(5001) // a second request changes nothing about what the reply says
    reply(r, [1], 5002)
    r.applyMessage(NODE_END_MSG, '2', 5002)
    expect(states(r)).toEqual([
      [1, true],
      [2, false]
    ])
    expect(r.seenInfo().get(2)).toMatchObject({ offlineAt: 5002, offlineVia: 'roster' })
  })

  it('with no reply arriving, a request still isolates the next reply from earlier deltas', () => {
    const r = new NodeRoster()
    r.applyMessage(NODE_MSG, row(1), 0) // a live delta: board 1 joined
    r.beginBurst(5000)
    reply(r, [3], 5001) // the reply no longer lists it
    r.applyMessage(NODE_END_MSG, '2', 5001)
    expect(states(r)).toEqual([
      [1, false],
      [3, true]
    ])
  })
})

describe('NodeRoster — a v2 bridge’s END completes nothing (M3)', () => {
  const V2 = '01010000000000000080000000' // 26 hex: a v2 row, dropped

  it('with a v2 bridge the roster never completes, so no board reads offline', () => {
    const r = new NodeRoster()
    r.beginBurst(0)
    r.applyMessage(NODE_MSG, V2, 1)
    r.applyMessage(NODE_END_MSG, '1', 1)
    expect(r.legacyBridge()).toBe(true)
    expect(r.rosterCompleteAt(), 'unknown, not a complete empty roster').toBeUndefined()
    expect(r.snapshot()).toEqual([])
  })

  it('a reset (a port open) forgets it: a v3 bridge on the new link completes as before', () => {
    const r = new NodeRoster()
    r.applyMessage(NODE_MSG, V2, 1)
    r.reset()
    expect(r.legacyBridge()).toBe(false)
    r.applyMessage(NODE_END_MSG, '0', 2)
    expect(r.rosterCompleteAt()).toBe(2)
  })
})

describe('nodeFaultTag', () => {
  it('uses the enriched abbr', () => {
    const n = node({
      degraded: true,
      faultId: 1,
      faultAbbr: 'I2C',
      faultLabel: 'I2C peripheral',
      faultDesc: 'an I2C device tripped its breaker'
    })
    expect(nodeFaultTag(n)).toBe('I2C')
  })
  it('falls back to `Fault N` for an unknown/reserved id (no enrichment)', () => {
    const n = node({ degraded: true, faultId: 0x99 })
    expect(nodeFaultTag(n)).toBe('Fault 153')
  })
})
