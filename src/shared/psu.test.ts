import { describe, expect, it } from 'vitest'
import { DEFAULT_PSU, effectivePsuLimits, parsePsuLimit, PSU_PRESETS, sanitizePsu } from './psu'

describe('sanitizePsu', () => {
  it('falls back to the default for junk', () => {
    for (const raw of [null, 3, 'x', [], {}]) expect(sanitizePsu(raw)).toEqual(DEFAULT_PSU)
  })

  it('keeps valid fields and drops bad ones field by field', () => {
    expect(
      sanitizePsu({ mode: 'custom', preset: 'acme', custom: { a12: 40, a5: -1, w: '650' } })
    ).toEqual({ mode: 'custom', preset: 'nx650', custom: { a12: 40 } })
  })
})

describe('effectivePsuLimits', () => {
  it('uses the preset, or what was entered — which a preset keeps for later', () => {
    const custom = { a12: 54, w: 650 }
    expect(effectivePsuLimits({ mode: 'preset', preset: 'nx650', custom })).toBe(
      PSU_PRESETS.nx650.limits
    )
    expect(effectivePsuLimits({ mode: 'custom', preset: 'nx650', custom })).toEqual(custom)
    expect(PSU_PRESETS.nx650.limits).toEqual({ a12: 54, a5: 20, w: 650 })
  })
})

describe('parsePsuLimit', () => {
  it('reads a positive number, treats empty as unknown, and refuses the rest', () => {
    expect(parsePsuLimit(' 54 ')).toBe(54)
    expect(parsePsuLimit('12.5')).toBe(12.5)
    expect(parsePsuLimit('')).toBeUndefined()
    expect(parsePsuLimit('  ')).toBeUndefined()
    for (const bad of ['0', '-5', 'abc', '5A', '1e3', '99999']) {
      expect(parsePsuLimit(bad)).toBeNull()
    }
  })
})
