import { describe, expect, it } from 'vitest'
import { NODE_END_MSG, NODE_MSG, NodeRoster, parseNodeStatus, nodeRosterRequest } from './nodes'

describe('parseNodeStatus', () => {
  it('decodes the documented example 030102000A00031100', () => {
    // nodeId 03, present 01, flags 02 (EPVF), uptime 000A, rxCount 0003, esr 1100
    const ns = parseNodeStatus('030102000A00031100')
    expect(ns).toEqual({
      nodeId: 3,
      present: true,
      boff: false,
      epvf: true,
      uptimeSec: 10,
      rxCount: 3,
      tec: 0x00, // esr low byte
      rec: 0x11 // esr high byte
    })
  })

  it('decodes present/removed and the CAN flags', () => {
    expect(parseNodeStatus('050100000000000000')?.present).toBe(true) // present=01
    expect(parseNodeStatus('050000000000000000')?.present).toBe(false) // present=00
    expect(parseNodeStatus('050003000000000000')?.boff).toBe(true) // flags bit0 BOFF
    expect(parseNodeStatus('050003000000000000')?.epvf).toBe(true) // flags bit1 EPVF
  })

  it('rejects malformed input', () => {
    expect(parseNodeStatus('zzzz')).toBeNull()
    expect(parseNodeStatus('010101000000000')).toBeNull() // wrong length
    expect(parseNodeStatus('000101000000000000')).toBeNull() // nodeId 0
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
    r.applyMessage(NODE_MSG, '010100000000000000') // node 1 present
    r.applyMessage(NODE_MSG, '020100000000000000') // node 2 present
    expect(r.snapshot().map((n) => n.nodeId)).toEqual([1, 2])
    r.applyMessage(NODE_MSG, '010000000000000000') // node 1 removed (present=00)
    expect(r.snapshot().map((n) => [n.nodeId, n.present])).toEqual([
      [1, false],
      [2, true]
    ])
  })

  it('marks nodes absent from a completed burst offline (but keeps them)', () => {
    const r = new NodeRoster()
    r.applyMessage(NODE_MSG, '010100000000000000') // node 1 present
    r.takeDirty()
    // a fresh roster request returns only node 3, then END
    r.beginBurst() // client sends the request → isolate the reply burst
    r.applyMessage(NODE_MSG, '030100000000000000')
    r.applyMessage(NODE_END_MSG, '1')
    expect(r.snapshot().map((n) => [n.nodeId, n.present])).toEqual([
      [1, false], // went silent → offline, still listed
      [3, true]
    ])
    expect(r.takeDirty()).toBe(true)
  })
})
