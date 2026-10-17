import { describe, expect, it } from 'vitest'
import type { CalSnapshot } from '@shared/hid/calibration'
import { FRESH_MS, hidFacts, RECENT_MS } from './hid-facts'

/** GET_CAL's answer with `present` slots declared. */
const snap = (present: number[]): CalSnapshot => ({
  presentMask: present.reduce((m, i) => m | (1 << i), 0),
  calibratedMask: 0,
  axes: Array.from({ length: 8 }, (_, idx) => ({
    idx,
    controlId: 0x10 + idx,
    min: 0,
    centre: 0,
    max: 0,
    deadzone: 0,
    present: present.includes(idx),
    calibrated: false
  })),
  serialNumber: 'BOARD-A'
})

describe('hidFacts (Hid.tsx before R3.3)', () => {
  it('bands the report by its age', () => {
    expect(
      [0, FRESH_MS - 1, FRESH_MS, RECENT_MS - 1, RECENT_MS].map(
        (a) => hidFacts(a, undefined, []).band
      )
    ).toEqual(['live', 'live', 'idle', 'idle', 'quiet'])
  })

  it('before the device reports: the catalogue alone, nothing declared', () => {
    const f = hidFacts(0, undefined, [0, 1, 2])
    expect(f.present).toBe(0)
    expect(f.axisLive).toEqual([true, true, true, false, false, false, false, false])
  })

  it('once it reports: catalogued and declared, and how many it declares', () => {
    const f = hidFacts(0, snap([0, 1, 5]), [0, 1, 2])
    expect(f.present).toBe(3)
    // Throttle (2) is catalogued but not declared; slot 5 is declared but not catalogued.
    expect(f.axisLive).toEqual([true, true, false, false, false, false, false, false])
  })
})
