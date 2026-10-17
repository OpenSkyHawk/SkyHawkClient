import { describe, expect, it } from 'vitest'
import { effectivePsuLimits, PSU_PRESETS, psuName, resolvePsu, sanitizePsu } from './psu-limits'
import { DEFAULT_PSU, parsePsuLimit } from '@shared/nodes'
import { PSU_VIEW_DEFAULT } from '@shared/config'

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

describe('psuName', () => {
  it('names a preset by its model and a custom supply plainly', () => {
    expect(psuName({ mode: 'preset', preset: 'nx650', custom: {} })).toBe('NX650')
    expect(psuName({ mode: 'custom', preset: 'nx650', custom: { w: 500 } })).toBe('PSU')
  })
})

describe('resolvePsu (R3.3: what config:changed carries)', () => {
  it('the preset, the limits the Cockpit uses and the PSU box name; the default as the renderer starts', () => {
    expect(resolvePsu(DEFAULT_PSU)).toEqual(PSU_VIEW_DEFAULT)
    const custom = { mode: 'custom' as const, preset: 'nx650' as const, custom: { w: 500 } }
    expect(resolvePsu(custom)).toEqual({
      name: 'PSU',
      limits: { w: 500 },
      preset: PSU_PRESETS.nx650
    })
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
