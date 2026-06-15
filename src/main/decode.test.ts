import { describe, expect, it } from 'vitest'
import { Decoder, extractValue } from './decode'

describe('extractValue', () => {
  it('masks and shifts', () => {
    expect(extractValue(0xff00, 0xff00, 8)).toBe(0xff)
    expect(extractValue(0b0000_1100, 0b0000_1100, 2)).toBe(0b11)
  })
  it('returns the raw word when mask is 0', () => {
    expect(extractValue(0x1234, 0, 0)).toBe(0x1234)
  })
})

describe('Decoder aircraft tracking', () => {
  it('reads _ACFT_NAME from the metadata string region', () => {
    const d = new Decoder()
    d.handle(0x0000, 'A'.charCodeAt(0) | ('-'.charCodeAt(0) << 8), 0)
    d.handle(0x0002, '4'.charCodeAt(0) | ('E'.charCodeAt(0) << 8), 0)
    d.handle(0x0004, 0, 0)
    const ac = d.aircraft()
    expect(ac?.name).toBe('A-4E')
    expect(ac?.inferred).toBe(false)
    expect(ac?.supported).toBe(true)
  })

  it('infers A-4E-C from the address range when no name seen', () => {
    const d = new Decoder()
    d.handle(0x8400, 0x1234, 0)
    const ac = d.aircraft()
    expect(ac?.name).toBe('A-4E-C')
    expect(ac?.inferred).toBe(true)
  })

  it('returns null when nothing changed', () => {
    const d = new Decoder()
    d.aircraft() // consume initial
    expect(d.aircraft()).toBeNull()
  })
})

describe('Decoder telemetry', () => {
  it('exposes the five readouts', () => {
    const ids = new Decoder().telemetrySnapshot().map((r) => r.id)
    expect(ids).toEqual(['RPM', 'D_IAS_DEG', 'D_FLAPS_IND', 'ALT_FT', 'D_FUEL'])
  })
})
