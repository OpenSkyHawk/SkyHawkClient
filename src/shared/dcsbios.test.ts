import { describe, expect, it } from 'vitest'
import { DcsBiosProtocol, StringRegion, formatCommand, ACFT_NAME_ADDRESS } from './dcsbios'

/** Build a sync + one write block: addr, then count bytes of data words. */
function frame(address: number, words: number[]): number[] {
  const bytes = [0x55, 0x55, 0x55, 0x55, address & 0xff, (address >> 8) & 0xff]
  const count = words.length * 2
  bytes.push(count & 0xff, (count >> 8) & 0xff)
  for (const w of words) bytes.push(w & 0xff, (w >> 8) & 0xff)
  return bytes
}

describe('DcsBiosProtocol', () => {
  it('decodes a single write block to address/value pairs', () => {
    const writes: [number, number][] = []
    const p = new DcsBiosProtocol((a, v) => writes.push([a, v]))
    p.processBuffer(new Uint8Array(frame(0x8400, [0x1234, 0xabcd])))
    expect(writes).toEqual([
      [0x8400, 0x1234],
      [0x8402, 0xabcd]
    ])
  })

  it('resyncs on four 0x55 bytes mid-stream', () => {
    const writes: [number, number][] = []
    const p = new DcsBiosProtocol((a, v) => writes.push([a, v]))
    // garbage, then a clean frame
    p.processBuffer(new Uint8Array([0x01, 0x02, 0x03, ...frame(0x0440, [0x00ff])]))
    expect(writes).toEqual([[0x0440, 0x00ff]])
  })

  it('handles data split across processBuffer calls', () => {
    const writes: [number, number][] = []
    const p = new DcsBiosProtocol((a, v) => writes.push([a, v]))
    const bytes = frame(0x0a00, [0x1111, 0x2222])
    p.processBuffer(new Uint8Array(bytes.slice(0, 7)))
    p.processBuffer(new Uint8Array(bytes.slice(7)))
    expect(writes).toEqual([
      [0x0a00, 0x1111],
      [0x0a02, 0x2222]
    ])
  })
})

describe('StringRegion', () => {
  it('reassembles a null-terminated name from word writes', () => {
    const r = new StringRegion(ACFT_NAME_ADDRESS, 24)
    // "A-4E" packed two chars per 16-bit word: 'A'|'-'<<8, '4'|'E'<<8
    r.update(0x0000, 'A'.charCodeAt(0) | ('-'.charCodeAt(0) << 8))
    r.update(0x0002, '4'.charCodeAt(0) | ('E'.charCodeAt(0) << 8))
    r.update(0x0004, 0) // terminator
    expect(r.value()).toBe('A-4E')
  })

  it('ignores writes outside the region', () => {
    const r = new StringRegion(0x0000, 4)
    expect(r.update(0x8400, 0x4142)).toBe(false)
  })
})

describe('formatCommand', () => {
  it('builds an identifier + arg line', () => {
    expect(formatCommand('MASTER_ARM', 1)).toBe('MASTER_ARM 1\n')
  })
})
