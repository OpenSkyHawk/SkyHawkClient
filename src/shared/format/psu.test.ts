import { describe, expect, it } from 'vitest'
import { PSU_LIMITS } from './psu'

describe('PSU_LIMITS', () => {
  it('names the three custom limits, in form order', () => {
    expect(PSU_LIMITS.map(({ key, label, unit }) => `${key}: ${label} (${unit})`)).toEqual([
      'a12: 12 V rail limit (A)',
      'a5: 5 V rail limit (A)',
      'w: Total power (W)'
    ])
  })

  it('carries the Settings hint for each', () => {
    expect(PSU_LIMITS.map((l) => l.hint)).toEqual([
      'Combined current of all 12 V outputs (PSU label)',
      'Combined current of all 5 V outputs (PSU label)',
      'Rated output (PSU label)'
    ])
  })
})
