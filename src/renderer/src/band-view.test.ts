// The health band's PSU headroom and the plan's PSU name (band-view.ts; from cockpit.test.ts, R3.2).
import { describe, expect, it } from 'vitest'
import { fmtPct } from '@shared/format'
import { headroom, psuName } from './band-view'

describe('headroom', () => {
  it('is null when the limit is unknown, so the card keeps its plain total', () => {
    expect(headroom(2.5, undefined)).toBeNull()
    expect(headroom(null, undefined)).toBeNull()
  })

  it('keeps the limit with an empty bar when there is no reading', () => {
    expect(headroom(null, 54)).toEqual({ limit: 54, pct: null, bar: 0 })
  })

  it('measures the value against the limit', () => {
    expect(headroom(0, 20)).toEqual({ limit: 20, pct: 0, bar: 0 })
    expect(headroom(5, 20)).toEqual({ limit: 20, pct: 25, bar: 25 })
    expect(headroom(650, 650)).toEqual({ limit: 650, pct: 100, bar: 100 })
  })

  it('caps the bar but not the share when over the limit', () => {
    expect(headroom(22.4, 20)).toMatchObject({ bar: 100 })
    expect(headroom(22.4, 20)?.pct).toBeCloseTo(112)
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

describe('psuName', () => {
  it('names a preset by its model and a custom supply plainly', () => {
    expect(psuName({ mode: 'preset', preset: 'nx650', custom: {} })).toBe('NX650')
    expect(psuName({ mode: 'custom', preset: 'nx650', custom: { w: 500 } })).toBe('PSU')
  })
})
