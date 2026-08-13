import { describe, expect, it } from 'vitest'
import { freshness, FRESH_MS, RECENT_MS } from './freshness'

const MIN = 60 * 1000

describe('report freshness', () => {
  it('never shows a fault colour for silence while the link is up', () => {
    // The gateway sends a HID report only when a control changes, so a cockpit nobody is
    // touching sends nothing. A fault colour here would cry wolf every time the user let go of
    // the stick, and the user would learn to ignore it — including when it meant something.
    for (const ageMs of [0, 5 * MIN, 30 * MIN, 6 * 60 * MIN, Number.MAX_SAFE_INTEGER]) {
      expect(freshness('relaying', ageMs).cls, `age ${ageMs}`).not.toBe('rate--down')
    }
  })

  it('reserves red for the link being down, when nothing could arrive', () => {
    // Every state that is not a live link, including the ones a pulled cable produces. The
    // original version keyed on whether the *relay* was running, which stays true while it
    // retries — so unplugging aged the card through its bands to 'quiet', claiming the device
    // had nothing to say when in fact it could not say anything.
    for (const state of ['error', 'reconnecting', 'no-device', 'scanning'] as const) {
      expect(freshness(state, 0).cls, state).toBe('rate--down')
      expect(freshness(state, 0).label, state).toBe('no link')
    }
    // A report a moment ago does not soften it: the link is gone now.
    expect(freshness('error', 1).cls).toBe('rate--down')
    // And a live link is not red, however old the last report.
    expect(freshness('connected', Number.MAX_SAFE_INTEGER).cls).not.toBe('rate--down')
  })

  it('steps down through the bands as reports age', () => {
    expect(freshness('relaying', 0).cls).toBe('rate--live')
    expect(freshness('relaying', FRESH_MS - 1).cls).toBe('rate--live')
    expect(freshness('relaying', FRESH_MS).cls, 'boundary belongs to the older band').toBe(
      'rate--idle'
    )
    expect(freshness('relaying', RECENT_MS - 1).cls).toBe('rate--idle')
    expect(freshness('relaying', RECENT_MS).cls).toBe('rate--stale')
  })

  it('is measured in minutes, not seconds', () => {
    // An axis untouched for a few seconds is being held still, not failing — the first band has
    // to outlast ordinary use. This pins the intent rather than the number, which has already
    // moved once.
    expect(FRESH_MS).toBeGreaterThanOrEqual(MIN)
    expect(RECENT_MS).toBeGreaterThan(FRESH_MS)
  })
})
