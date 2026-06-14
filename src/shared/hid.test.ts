import { describe, it, expect } from 'vitest'
import { decodeAxis, isButtonPressed, decodeHat, decodeReport, HID_REPORT_SIZE } from './hid'

describe('HID decode', () => {
  it('decodeAxis sign-extends a 16-bit field', () => {
    expect(decodeAxis(0x0000)).toBe(0)
    expect(decodeAxis(0x7fff)).toBe(32767)
    expect(decodeAxis(0x8000)).toBe(-32768)
    expect(decodeAxis(0xffff)).toBe(-1)
  })

  it('isButtonPressed reads the correct bit', () => {
    const b = new Uint8Array(16)
    b[0] = 0b0000_0001 // button 0
    b[1] = 0b0000_0100 // button 10 (byte 1, bit 2)
    expect(isButtonPressed(b, 0)).toBe(true)
    expect(isButtonPressed(b, 1)).toBe(false)
    expect(isButtonPressed(b, 10)).toBe(true)
    expect(isButtonPressed(b, 127)).toBe(false)
    expect(isButtonPressed(b, 200)).toBe(false)
  })

  it('decodeHat maps wire 0..7 = N..NW, >=8 = centre', () => {
    expect(decodeHat(0)).toBe(1) // N
    expect(decodeHat(1)).toBe(2) // NE
    expect(decodeHat(7)).toBe(8) // NW
    expect(decodeHat(8)).toBe(0) // centre
    expect(decodeHat(0xf)).toBe(0) // null/centre
  })

  it('decodeReport parses a full 34-byte report', () => {
    const r = new Uint8Array(HID_REPORT_SIZE)
    r[0] = 0b0000_0001 // button 0 pressed
    r[16] = 0x10 // hat0 nibble 0 = N (->1), hat1 nibble 1 = NE (->2)
    // axis 0 = +100 (little-endian int16) at offset 18
    r[18] = 100 & 0xff
    r[19] = (100 >> 8) & 0xff
    const out = decodeReport(r)
    expect(out.buttons[0]).toBe(true)
    expect(out.buttons[1]).toBe(false)
    expect(out.hats[0]).toBe(1) // N
    expect(out.hats[1]).toBe(2) // NE
    expect(out.axes[0]).toBe(100)
    expect(out.axes).toHaveLength(8)
  })

  it('decodeReport rejects a short buffer', () => {
    expect(() => decodeReport(new Uint8Array(10))).toThrow()
  })
})
