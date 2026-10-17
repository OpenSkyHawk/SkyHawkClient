import { describe, expect, it } from 'vitest'
import { amps, fmtBytes, fmtPct, hex2, hex4, volts, voltsValue } from './units'

describe('volts / amps', () => {
  it('volts: millivolts as "12.00 V"', () => {
    expect(volts(4710)).toBe('4.71 V')
    expect(volts(4900)).toBe('4.90 V')
    expect(volts(12050)).toBe('12.05 V')
  })

  it('voltsValue: the same number, no unit', () => {
    expect(voltsValue(12000)).toBe('12.00')
    expect(voltsValue(5020)).toBe('5.02')
  })

  it('amps: milliamps as "1.50 A"', () => {
    expect(amps(1500)).toBe('1.50 A')
    expect(amps(20)).toBe('0.02 A')
    expect(amps(0)).toBe('0.00 A')
  })
})

describe('fmtBytes', () => {
  it('B/s below 1 KB, KB/s with one decimal from there', () => {
    expect(fmtBytes(1000)).toBe('1000 B/s')
    expect(fmtBytes(512.6)).toBe('513 B/s')
    expect(fmtBytes(1023.9)).toBe('1024 B/s')
    expect(fmtBytes(1024)).toBe('1.0 KB/s')
    expect(fmtBytes(2048.4)).toBe('2.0 KB/s')
  })
})

describe('fmtPct', () => {
  it('shows one decimal under 10 % and whole numbers from there', () => {
    expect(fmtPct(0)).toBe('0.0%')
    expect(fmtPct(4.59)).toBe('4.6%')
    expect(fmtPct(9.94)).toBe('9.9%')
    expect(fmtPct(9.96)).toBe('10%')
    expect(fmtPct(53.2)).toBe('53%')
    expect(fmtPct(112)).toBe('112%')
  })
})

describe('hex2 / hex4', () => {
  it('hex2: the low byte, two upper-case digits', () => {
    expect(hex2(0x12)).toBe('12')
    expect(hex2(0xab)).toBe('AB')
    expect(hex2(0x1234)).toBe('34')
    expect(hex2(5)).toBe('05')
  })

  it('hex4: the low 16 bits as 0x + four upper-case digits', () => {
    expect(hex4(0x1234)).toBe('0x1234')
    expect(hex4(0xabcd)).toBe('0xABCD')
    expect(hex4(0xff)).toBe('0x00FF')
    expect(hex4(0x12345)).toBe('0x2345')
  })
})
