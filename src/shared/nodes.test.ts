import { describe, expect, it } from 'vitest'
import {
  NODE_END_MSG,
  NODE_MSG,
  NodeRoster,
  parseNodeStatus,
  nodeRosterRequest,
  nodeDotState,
  nodeFaultTag,
  nodeFaultTooltip,
  type NodeStatus
} from './nodes'

const node = (over: Partial<NodeStatus>): NodeStatus => ({
  nodeId: 1,
  present: true,
  boff: false,
  epvf: false,
  uptimeSec: 0,
  rxCount: 0,
  tec: 0,
  rec: 0,
  dieTempC: 30,
  overheat: false,
  degraded: false,
  faultId: 0,
  ...over
})

describe('parseNodeStatus', () => {
  it('decodes the documented example 030102000A0003110024000000', () => {
    // nodeId 03, present 01, flags 02 (EPVF), uptime 000A, rxCount 0003, esr 1100,
    // dieTempC 24 (36 C), hFlags 00, faultMask 00, faultId 00
    const ns = parseNodeStatus('030102000A0003110024000000')
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
      faultId: 0
    })
  })

  it('decodes present/removed and the CAN flags', () => {
    expect(parseNodeStatus('05010000000000000080000000')?.present).toBe(true) // present=01
    expect(parseNodeStatus('05000000000000000080000000')?.present).toBe(false) // present=00
    expect(parseNodeStatus('05010300000000000080000000')?.boff).toBe(true) // flags bit0 BOFF
    expect(parseNodeStatus('05010300000000000080000000')?.epvf).toBe(true) // flags bit1 EPVF
  })

  it('decodes the HEALTH_n telemetry fields (proto v2)', () => {
    // dieTempC 24 = 36 C
    expect(parseNodeStatus('05010000000000000024000000')?.dieTempC).toBe(36)
    // dieTempC EC = -20 C (int8 two's-complement)
    expect(parseNodeStatus('050100000000000000EC000000')?.dieTempC).toBe(-20)
    // dieTempC 80 = INT8_MIN sentinel = not-yet-seen => null
    expect(parseNodeStatus('05010000000000000080000000')?.dieTempC).toBeNull()
    // hFlags bit0 overheat, bit1 degraded
    expect(parseNodeStatus('05010000000000000080010000')?.overheat).toBe(true)
    expect(parseNodeStatus('05010000000000000080020000')?.degraded).toBe(true)
    expect(parseNodeStatus('05010000000000000080000000')?.degraded).toBe(false)
    // faultId passes through (last byte)
    expect(parseNodeStatus('0501000000000000008002000A')?.faultId).toBe(0x0a)
  })

  it('rejects malformed input', () => {
    expect(parseNodeStatus('zzzz')).toBeNull()
    expect(parseNodeStatus('010100000000000080000000')).toBeNull() // 24 chars — wrong length
    expect(parseNodeStatus('05010000000000000080000000ab')).toBeNull() // 28 chars — wrong length
    expect(parseNodeStatus('00010000000000000080000000')).toBeNull() // nodeId 0
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
    r.applyMessage(NODE_MSG, '01010000000000000080000000') // node 1 present
    r.applyMessage(NODE_MSG, '02010000000000000080000000') // node 2 present
    expect(r.snapshot().map((n) => n.nodeId)).toEqual([1, 2])
    r.applyMessage(NODE_MSG, '01000000000000000080000000') // node 1 removed (present=00)
    expect(r.snapshot().map((n) => [n.nodeId, n.present])).toEqual([
      [1, false],
      [2, true]
    ])
  })

  it('marks nodes absent from a completed burst offline (but keeps them)', () => {
    const r = new NodeRoster()
    r.applyMessage(NODE_MSG, '01010000000000000080000000') // node 1 present
    r.takeDirty()
    // a fresh roster request returns only node 3, then END
    r.beginBurst() // client sends the request → isolate the reply burst
    r.applyMessage(NODE_MSG, '03010000000000000080000000')
    r.applyMessage(NODE_END_MSG, '1')
    expect(r.snapshot().map((n) => [n.nodeId, n.present])).toEqual([
      [1, false], // went silent → offline, still listed
      [3, true]
    ])
    expect(r.takeDirty()).toBe(true)
  })
})

describe('nodeDotState', () => {
  it('offline wins over everything', () => {
    expect(nodeDotState(node({ present: false, degraded: true, overheat: true }))).toBe('off')
  })
  it('present + degraded or overheat → warn (amber)', () => {
    expect(nodeDotState(node({ degraded: true }))).toBe('warn')
    expect(nodeDotState(node({ overheat: true }))).toBe('warn')
  })
  it('present + healthy → on', () => {
    expect(nodeDotState(node({}))).toBe('on')
  })
})

describe('nodeFaultTag / nodeFaultTooltip', () => {
  it('uses the enriched abbr + label + description', () => {
    const n = node({
      degraded: true,
      faultId: 1,
      faultAbbr: 'I2C',
      faultLabel: 'I2C peripheral',
      faultDesc: 'an I2C device tripped its breaker'
    })
    expect(nodeFaultTag(n)).toBe('I2C')
    expect(nodeFaultTooltip(n)).toBe('I2C peripheral — an I2C device tripped its breaker')
  })
  it('falls back to `Fault N` for an unknown/reserved id (no enrichment)', () => {
    const n = node({ degraded: true, faultId: 0x99 })
    expect(nodeFaultTag(n)).toBe('Fault 153')
    expect(nodeFaultTooltip(n)).toBe('Fault 153')
  })
  it('tooltip is the label alone when there is no description', () => {
    expect(
      nodeFaultTooltip(node({ faultId: 2, faultAbbr: 'OVER', faultLabel: 'Over voltage' }))
    ).toBe('Over voltage')
  })
})
