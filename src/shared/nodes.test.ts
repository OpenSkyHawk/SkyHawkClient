import { describe, expect, it } from 'vitest'
import {
  NODE_END_MSG,
  NODE_MSG,
  NodeRoster,
  ROSTER_REPLY_MS,
  cleanNodeLine,
  isLegacyNodeStatus,
  parseNodeStatus,
  nodeRosterRequest,
  nodeFaultTag,
  type NodeStatus
} from './nodes'
import { nodeStatus } from '../test-fixtures/nodes'

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
