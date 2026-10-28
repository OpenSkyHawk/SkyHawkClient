import { describe, expect, it } from 'vitest'
import {
  canRequestRoster,
  cleanNodeLine,
  endRowCount,
  NODE_END_MSG,
  NODE_MSG,
  NodeRoster,
  nodeRosterRequest,
  olderNodeStatus,
  parseNodeStatus,
  ROSTER_REPLY_MS
} from './node-status-wire'
import { nodeFaultTag } from './faults'
import type { NodeStatus } from '@shared/nodes'
import { nodeStatus, statusRow } from '../../test-fixtures/nodes'

const node = (over: Partial<NodeStatus>): NodeStatus =>
  nodeStatus(1, { uptimeSec: 0, rxCount: 0, ...over })

describe('parseNodeStatus', () => {
  it('decodes a v4 row (38 hex: v3, then the firmware version and the bootloader state)', () => {
    // nodeId 03, present 01, flags 02 (EPVF), uptime 000A, rxCount 0003, esr 1100,
    // dieTempC 24 (36 C), hFlags 00, faultMask 00, faultId 00, nodeKind 02 (PDU),
    // fw 01.02.03, bootloader 01, bootState 00 (the app is running)
    const ns = parseNodeStatus('030102000A00031100240000000201020301' + '00')
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
      nodeKind: 2,
      fwMajor: 1,
      fwMinor: 2,
      fwPatch: 3,
      bootloader: 1,
      bootState: 0
    })
  })

  it('a version of 00 00 00 is "not reported", and the bootloader fields pass through raw', () => {
    const ns = parseNodeStatus('0101000000000000008000000001' + '000000' + '00' + '00')
    expect(ns).toMatchObject({ fwMajor: 0, fwMinor: 0, fwPatch: 0, bootloader: 0, bootState: 0 })
    // In its bootloader, update traffic flowing: NODE_BOOT_STATE_UPDATING (0x80) | a BootState.
    const boot = parseNodeStatus('0101000000000000008000000001' + '000000' + '02' + '83')
    expect(boot).toMatchObject({ bootloader: 2, bootState: 0x83 })
  })

  it('reads a longer row by its v4 prefix: fields a newer bridge appended are ignored (D22)', () => {
    const v4 = '0501000000000000008000000001' + '010203' + '0100'
    expect(parseNodeStatus(v4 + 'ABCD')).toEqual(parseNodeStatus(v4))
    expect(parseNodeStatus(v4 + 'ABCD')).toMatchObject({ nodeId: 5, nodeKind: 1, fwPatch: 3 })
  })

  it("decodes the bridge's own row (node 0, kind 03) and passes unknown values through", () => {
    expect(parseNodeStatus(statusRow(0, true, 3))).toMatchObject({ nodeId: 0, nodeKind: 3 })
    expect(parseNodeStatus(statusRow(0x29, true, 7))?.nodeKind).toBe(7) // a newer kind
    // An unknown fault code, and flag bits this client has no name for: kept, never an error.
    const odd = parseNodeStatus('05012100000000000080FC00EE01' + '000000' + '0000')
    expect(odd).toMatchObject({ faultId: 0xee, boff: true, epvf: false, overheat: false })
    expect(odd?.degraded).toBe(false)
  })

  it('decodes present/removed and the CAN flags', () => {
    const row = (head: string) =>
      parseNodeStatus(head + '000000000000' + '80000000' + '00' + '0000000000')
    expect(row('050100')?.present).toBe(true) // present=01
    expect(row('050000')?.present).toBe(false) // present=00
    expect(row('050103')?.boff).toBe(true) // flags bit0 BOFF
    expect(row('050103')?.epvf).toBe(true) // flags bit1 EPVF
  })

  it('decodes the HEALTH_n telemetry fields', () => {
    // From the die temperature on: dieTempC, hFlags, faultMask, faultId, then kind 00 and v4's tail.
    const row = (tail: string) => parseNodeStatus('05010000000000000' + tail + '00' + '0000000000')
    expect(row('0' + '24000000')?.dieTempC).toBe(36) // 24 = 36 C
    expect(row('0' + 'EC000000')?.dieTempC).toBe(-20) // EC = -20 C (int8 two's-complement)
    expect(row('0' + '80000000')?.dieTempC).toBeNull() // 80 = INT8_MIN sentinel = not yet seen
    expect(row('0' + '80010000')?.overheat).toBe(true) // hFlags bit0
    expect(row('0' + '80020000')?.degraded).toBe(true) // hFlags bit1
    expect(row('0' + '80000000')?.degraded).toBe(false)
    expect(row('0' + '8002000A')?.faultId).toBe(0x0a) // faultId passes through
  })

  it('rejects malformed input and rows shorter than v4', () => {
    expect(parseNodeStatus('zzzz')).toBeNull()
    expect(parseNodeStatus('05010000000000000080000000')).toBeNull() // 26 chars — a v2 row
    expect(parseNodeStatus('0501000000000000008000000001')).toBeNull() // 28 chars — a v3 row
    expect(parseNodeStatus(statusRow(5).slice(0, 36))).toBeNull() // one byte short
    expect(parseNodeStatus(statusRow(5) + 'a')).toBeNull() // half a byte
    expect(parseNodeStatus(statusRow(5).replace(/^05/, 'zz'))).toBeNull()
    expect(parseNodeStatus(statusRow(64))).toBeNull() // nodeId 64
  })

  it('tells an older bridge’s row apart from a corrupt or cut-short one, so it can be reported', () => {
    expect(olderNodeStatus('05010000000000000080000000')).toBe(2) // 26 hex
    expect(olderNodeStatus('0501000000000000008000000001')).toBe(3) // 28 hex
    expect(olderNodeStatus(statusRow(5))).toBeUndefined() // v4
    expect(olderNodeStatus(statusRow(5).slice(0, 30))).toBeUndefined() // a line cut short
    expect(olderNodeStatus('zz010000000000000080000000')).toBeUndefined()
  })

  it('cuts UART noise off the front of a node-status line, and nothing else', () => {
    // Seen on the bench right after a PanelBridge reset: '_\xfe' before the node-0 row.
    expect(cleanNodeLine(`_\xfe_NODE_STATUS ${statusRow(0, true, 3)}`)).toBe(
      `_NODE_STATUS ${statusRow(0, true, 3)}`
    )
    expect(cleanNodeLine(`_NODE_STATUS ${statusRow(1)}`)).toBe(`_NODE_STATUS ${statusRow(1)}`)
    expect(cleanNodeLine('MY_NODE_LAMP 1')).toBe('MY_NODE_LAMP 1') // printable prefix: left alone
    expect(cleanNodeLine('UFC_1 1')).toBe('UFC_1 1')
  })
})

describe('nodeRosterRequest', () => {
  // 0x86FE was a live DCS-BIOS address (AH-64D, Mirage F1); 0xFF00 is used by no module (D23).
  it('encodes a sync+export frame for 0xFF00 = 1', () => {
    expect([...nodeRosterRequest()]).toEqual([
      0x55, 0x55, 0x55, 0x55, 0x00, 0xff, 0x02, 0x00, 0x01, 0x00
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
    r.applyMessage(NODE_MSG, '01010000000000000080000000000000000000') // node 1 present
    r.applyMessage(NODE_MSG, '02010000000000000080000000000000000000') // node 2 present
    expect(r.snapshot().map((n) => n.nodeId)).toEqual([1, 2])
    r.applyMessage(NODE_MSG, '01000000000000000080000000000000000000') // node 1 removed (present=00)
    expect(r.snapshot().map((n) => [n.nodeId, n.present])).toEqual([
      [1, false],
      [2, true]
    ])
  })

  it('marks nodes absent from a completed burst offline (but keeps them)', () => {
    const r = new NodeRoster()
    r.applyMessage(NODE_MSG, '01010000000000000080000000000000000000') // node 1 present
    r.takeDirty()
    // a fresh roster request returns only node 3, then END
    r.beginBurst() // client sends the request → isolate the reply burst
    r.applyMessage(NODE_MSG, '03010000000000000080000000000000000000')
    r.applyMessage(NODE_END_MSG, '1')
    expect(r.snapshot().map((n) => [n.nodeId, n.present])).toEqual([
      [1, false], // went silent → offline, still listed
      [3, true]
    ])
    expect(r.takeDirty()).toBe(true)
  })

  it('records first-seen, online-since, the last report, and when / how a node went offline', () => {
    const r = new NodeRoster()
    r.applyMessage(NODE_MSG, '01010000000000000080000000000000000000', 1000)
    expect(r.seenInfo().get(1)).toEqual({ firstSeenAt: 1000, onlineSince: 1000, reportedAt: 1000 })
    r.applyMessage(NODE_MSG, '01000000000000000080000000000000000000', 5000) // live delta: offline
    expect(r.seenInfo().get(1)).toEqual({
      firstSeenAt: 1000,
      reportedAt: 1000, // its last report stays: "last report N s ago"
      offlineAt: 5000,
      offlineVia: 'delta'
    })
    r.applyMessage(NODE_MSG, '01000000000000000080000000000000000000', 6000) // repeat keeps the first time
    expect(r.seenInfo().get(1)?.offlineAt).toBe(5000)
    // Back online: online since now (S6), first seen still 1000.
    r.applyMessage(NODE_MSG, '01010000000000000080000000000000000000', 7000)
    expect(r.seenInfo().get(1)).toEqual({ firstSeenAt: 1000, onlineSince: 7000, reportedAt: 7000 })
    r.applyMessage(NODE_MSG, '01010000000000000080000000000000000000', 9000) // still online: since 7000
    expect(r.seenInfo().get(1)).toEqual({ firstSeenAt: 1000, onlineSince: 7000, reportedAt: 9000 })
  })

  it('online since: a first absent row sets none; a roster END that finds it missing clears it (S6)', () => {
    const r = new NodeRoster()
    r.applyMessage(NODE_MSG, '01000000000000000080000000000000000000', 0) // listed absent first
    expect(r.seenInfo().get(1)?.onlineSince).toBeUndefined()
    r.applyMessage(NODE_MSG, '01010000000000000080000000000000000000', 60_000)
    expect(r.seenInfo().get(1)).toMatchObject({ firstSeenAt: 0, onlineSince: 60_000 })
    r.beginBurst(70_000)
    r.applyMessage(NODE_END_MSG, '', 70_000) // a reply without it: offline
    expect(r.seenInfo().get(1)).toMatchObject({ offlineAt: 70_000 })
    expect(r.seenInfo().get(1)?.onlineSince).toBeUndefined()
  })

  it('an offline found by a roster reply is marked roster, and the first END is remembered', () => {
    const r = new NodeRoster()
    r.applyMessage(NODE_MSG, '01010000000000000080000000000000000000', 0)
    r.applyMessage(NODE_MSG, '02010000000000000080000000000000000000', 0)
    expect(r.rosterCompleteAt()).toBeUndefined()
    r.beginBurst(3999)
    r.applyMessage(NODE_MSG, '02000000000000000080000000000000000000', 4000) // in the reply, reported absent
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
    r.applyMessage(NODE_MSG, '01010000000000000080000000000000000000', 0)
    r.applyMessage(NODE_MSG, '02010000000000000080000000000000000000', 0)
    r.beginBurst(1000) // the bridge never answers with _NODE_STATUS_END
    r.applyMessage(NODE_MSG, '01000000000000000080000000000000000000', 1000 + ROSTER_REPLY_MS)
    expect(r.seenInfo().get(1)?.offlineVia).toBe('roster') // inside the reply window
    r.applyMessage(NODE_MSG, '02000000000000000080000000000000000000', 1001 + ROSTER_REPLY_MS)
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

describe('NodeRoster — a reply missing a line reconciles nothing (#132)', () => {
  const row = (id: number) => statusRow(id, true, id === 0 ? 3 : 1)
  /** One v3 reply: the node-0 row, a row per board (less any `lost`), END with the true count. */
  const reply = (r: NodeRoster, ids: number[], t: number, lost: number[] = []) => {
    r.beginBurst(t)
    for (const id of [0, ...ids]) if (!lost.includes(id)) r.applyMessage(NODE_MSG, row(id), t)
    r.applyMessage(NODE_END_MSG, String(ids.length + 1), t) // PanelBridge counts node 0 too
  }
  const states = (r: NodeRoster) =>
    r
      .snapshot()
      .filter((n) => n.nodeId !== 0)
      .map((n) => [n.nodeId, n.present])

  it('the END count is PanelBridge’s rows, node 0 included; no count is undefined', () => {
    expect(endRowCount('3')).toBe(3)
    expect(endRowCount(' 1\r')).toBe(1)
    expect(endRowCount('')).toBeUndefined()
    expect(endRowCount('x')).toBeUndefined()
  })

  it('a board whose line was lost keeps its state; the next whole reply decides', () => {
    const r = new NodeRoster()
    reply(r, [1, 2, 3], 0)
    reply(r, [1, 2, 3], 5000, [2]) // board 2's line is lost on the way
    expect(states(r)).toEqual([
      [1, true],
      [2, true],
      [3, true]
    ])
    expect(r.seenInfo().get(2)?.offlineAt).toBeUndefined()
    expect(r.takeIncompleteReply()).toEqual({ expected: 4, received: 3 })
    expect(r.takeIncompleteReply()).toBeUndefined() // taken once
    reply(r, [1, 3], 10_000) // board 2 really left: the next whole reply says so
    expect(states(r)).toEqual([
      [1, true],
      [2, false],
      [3, true]
    ])
    expect(r.seenInfo().get(2)).toMatchObject({ offlineAt: 10_000, offlineVia: 'roster' })
    expect(r.takeIncompleteReply()).toBeUndefined()
  })

  it('a whole reply still marks a missing board offline', () => {
    const r = new NodeRoster()
    reply(r, [1, 2], 0)
    reply(r, [1], 5000)
    expect(states(r)).toEqual([
      [1, true],
      [2, false]
    ])
  })

  it('a lost node-0 row or END is a short reply too: nothing goes offline', () => {
    const r = new NodeRoster()
    reply(r, [1, 2], 0)
    reply(r, [1, 2], 5000, [0]) // the node-0 row is lost
    expect(r.takeIncompleteReply()).toEqual({ expected: 3, received: 2 })
    expect(states(r)).toEqual([
      [1, true],
      [2, true]
    ])
    // The END of the next reply is lost; the one after it ends whole.
    r.beginBurst(10_000)
    for (const id of [0, 1]) r.applyMessage(NODE_MSG, row(id), 10_000)
    reply(r, [1, 2], 15_000)
    expect(states(r)).toEqual([
      [1, true],
      [2, true]
    ])
  })

  it('a first reply that is short leaves the roster incomplete: remembered boards stay unknown', () => {
    const r = new NodeRoster()
    reply(r, [1, 2], 0, [2])
    expect(r.rosterCompleteAt()).toBeUndefined()
    reply(r, [1, 2], 5000)
    expect(r.rosterCompleteAt()).toBe(5000)
  })

  it('deltas before a reply’s node-0 row are not counted as its rows', () => {
    const r = new NodeRoster()
    reply(r, [1, 2], 0)
    r.beginBurst(5000)
    r.applyMessage(NODE_MSG, statusRow(2, false, 1), 5001) // a live delta: board 2 dropped
    for (const id of [0, 1]) r.applyMessage(NODE_MSG, row(id), 5002)
    r.applyMessage(NODE_END_MSG, '2', 5002) // whole: node 0 and board 1
    expect(r.takeIncompleteReply()).toBeUndefined()
    expect(states(r)).toEqual([
      [1, true],
      [2, false]
    ])
  })

  it('an END with no count completes as before', () => {
    const r = new NodeRoster()
    r.applyMessage(NODE_MSG, row(1), 0)
    r.beginBurst(5000)
    r.applyMessage(NODE_END_MSG, '', 5000)
    expect(states(r)).toEqual([[1, false]])
    expect(r.rosterCompleteAt()).toBe(5000)
  })
})

describe('NodeRoster — an older bridge’s END completes nothing (M3)', () => {
  const V2 = '01010000000000000080000000' // 26 hex: a v2 row, dropped
  const V3 = '0101000000000000008000000001' // 28 hex: a v3 row, dropped

  it('with an older bridge the roster never completes, so no board reads offline', () => {
    for (const [row, v] of [
      [V2, 2],
      [V3, 3]
    ] as const) {
      const r = new NodeRoster()
      r.beginBurst(0)
      r.applyMessage(NODE_MSG, row, 1)
      r.applyMessage(NODE_END_MSG, '1', 1)
      expect(r.legacyBridge(), `v${v}`).toBe(v)
      expect(r.rosterCompleteAt(), 'unknown, not a complete empty roster').toBeUndefined()
      expect(r.snapshot()).toEqual([])
    }
  })

  it('a line cut short is malformed, not an older bridge: the reply still decides', () => {
    const r = new NodeRoster()
    r.applyMessage(NODE_MSG, statusRow(0, true, 3), 1)
    r.applyMessage(NODE_MSG, statusRow(1).slice(0, 20), 1)
    expect(r.legacyBridge()).toBeUndefined()
    r.applyMessage(NODE_END_MSG, '1', 1)
    expect(r.rosterCompleteAt()).toBe(1)
  })

  it('a current row clears it: that bridge is current, and its END completes', () => {
    const r = new NodeRoster()
    r.applyMessage(NODE_MSG, V3, 1)
    r.applyMessage(NODE_MSG, statusRow(0, true, 3), 2)
    expect(r.legacyBridge()).toBeUndefined()
    r.applyMessage(NODE_END_MSG, '1', 2)
    expect(r.rosterCompleteAt()).toBe(2)
  })

  it('a reset (a port open) forgets it: a v4 bridge on the new link completes as before', () => {
    const r = new NodeRoster()
    r.applyMessage(NODE_MSG, V2, 1)
    r.reset()
    expect(r.legacyBridge()).toBeUndefined()
    r.applyMessage(NODE_END_MSG, '0', 2)
    expect(r.rosterCompleteAt()).toBe(2)
  })
})

describe('NodeRoster — held while the Gateway’s cockpit side updates (#187)', () => {
  const ROW = (id: number) =>
    `${id.toString(16).padStart(2, '0')}010000000000000080000000000000000000`
  /** Node 0 and board 1 on the bus, from a whole reply. */
  function onBus(): NodeRoster {
    const r = new NodeRoster()
    r.beginBurst(0)
    r.applyMessage(NODE_MSG, ROW(0), 1)
    r.applyMessage(NODE_MSG, ROW(1), 2)
    r.applyMessage(NODE_END_MSG, '2', 3)
    return r
  }
  const board1 = (r: NodeRoster) => r.snapshot().find((n) => n.nodeId === 1)?.present

  it('the restarted bridge’s short roster offlines no board while held', () => {
    const r = onBus()
    r.hold()
    r.applyMessage(NODE_MSG, ROW(0), 100) // its boot roster: its own row only
    r.applyMessage(NODE_END_MSG, '1', 101)
    r.beginBurst(200)
    r.applyMessage(NODE_MSG, ROW(0), 201)
    r.applyMessage(NODE_END_MSG, '1', 202)
    expect(board1(r)).toBe(true)
    expect(r.isHeld).toBe(true)
  })

  it('after release, only a reply to a request from `judgeFrom` on judges the boards', () => {
    const r = onBus()
    r.hold()
    r.release(5_000)
    r.beginBurst(1_000) // asked too soon: the boards' heartbeats may not be in yet
    r.applyMessage(NODE_MSG, ROW(0), 1_001)
    r.applyMessage(NODE_END_MSG, '1', 1_002)
    expect(board1(r)).toBe(true)
    r.beginBurst(5_000)
    r.applyMessage(NODE_MSG, ROW(0), 5_001)
    r.applyMessage(NODE_END_MSG, '1', 5_002)
    expect(board1(r)).toBe(false)
  })

  it('kept through a reconnect during the update', () => {
    const r = onBus()
    r.hold()
    r.reset()
    r.applyMessage(NODE_MSG, ROW(0), 10)
    r.applyMessage(NODE_MSG, ROW(1), 11)
    r.applyMessage(NODE_END_MSG, '1', 12) // a reply short of nothing, still held
    expect(r.isHeld).toBe(true)
    expect(r.rosterCompleteAt()).toBeUndefined()
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
  it('falls back to `UNKNOWN FAULT (0xNN)` for an unknown/reserved id (no enrichment, #183)', () => {
    const n = node({ degraded: true, faultId: 0x99 })
    expect(nodeFaultTag(n)).toBe('UNKNOWN FAULT (0x99)')
  })
})
