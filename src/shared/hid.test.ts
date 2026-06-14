import { describe, it, expect } from 'vitest'
import { decodeAxis, isButtonPressed, decodeHat, decodeReport, HID_REPORT_SIZE } from './hid'

describe('HID decode', () => {
  it('decodeAxis centres at 0x8000', () => {
    expect(decodeAxis(0x8000)).toBe(0)
    expect(decodeAxis(0x0000)).toBe(-0x8000)
    expect(decodeAxis(0xffff)).toBe(0x7fff)
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

  it('decodeHat nulls out-of-range nibbles', () => {
    expect(decodeHat(0)).toBe(0)
    expect(decodeHat(1)).toBe(1)
    expect(decodeHat(8)).toBe(8)
    expect(decodeHat(0xf)).toBe(0)
  })

  it('decodeReport parses a full 34-byte report', () => {
    const r = new Uint8Array(HID_REPORT_SIZE)
    r[0] = 0b0000_0001 // button 0 pressed
    r[16] = 0x21 // hat0 = 1 (N), hat1 = 2 (NE)
    // axis 0 = +100 (little-endian int16) at offset 18
    r[18] = 100 & 0xff
    r[19] = (100 >> 8) & 0xff
    const out = decodeReport(r)
    expect(out.buttons[0]).toBe(true)
    expect(out.buttons[1]).toBe(false)
    expect(out.hats[0]).toBe(1)
    expect(out.hats[1]).toBe(2)
    expect(out.axes[0]).toBe(100)
    expect(out.axes).toHaveLength(8)
  })

  it('decodeReport rejects a short buffer', () => {
    expect(() => decodeReport(new Uint8Array(10))).toThrow()
  })
})
