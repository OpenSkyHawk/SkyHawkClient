import { describe, expect, it } from 'vitest'
import { freshness, FRESH_MS, RECENT_MS } from './freshness'

const MIN = 60 * 1000

describe('report freshness', () => {
  it('never shows a fault colour for silence while the link is up', () => {
    // The gateway sends a HID report only when a control changes, so a cockpit nobody is
    // touching sends nothing. A fault colour here would cry wolf every time the user let go of
    // the stick, and the user would learn to ignore it — including when it meant something.
    for (const ageMs of [0, 5 * MIN, 30 * MIN, 6 * 60 * MIN, Number.MAX_SAFE_INTEGER]) {
      expect(freshness(true, ageMs).cls, `age ${ageMs}`).not.toBe('rate--down')
    }
  })

  it('reserves red for the link being down, when nothing could arrive', () => {
    expect(freshness(false, 0).cls).toBe('rate--down')
    // Even a report that arrived a moment ago does not soften it: the link is gone now.
    expect(freshness(false, 1).label).toBe('no link')
  })

  it('steps down through the bands as reports age', () => {
    expect(freshness(true, 0).cls).toBe('rate--live')
    expect(freshness(true, FRESH_MS - 1).cls).toBe('rate--live')
    expect(freshness(true, FRESH_MS).cls, 'boundary belongs to the older band').toBe('rate--idle')
    expect(freshness(true, RECENT_MS - 1).cls).toBe('rate--idle')
    expect(freshness(true, RECENT_MS).cls).toBe('rate--stale')
  })

  it('is measured in minutes, not seconds', () => {
    // An axis untouched for eight minutes says nothing about the hardware, so the first band has
    // to be long enough to cover ordinary use. This pins the intent rather than the number.
    expect(FRESH_MS).toBeGreaterThanOrEqual(5 * MIN)
    expect(RECENT_MS).toBeGreaterThan(FRESH_MS)
  })
})
