import { describe, expect, it } from 'vitest'
import type { DeviceState } from '@shared/gateway'
import { isBoardPresent } from '../../../main/gateway/link-state'
import { FRESH_MS, freshnessBand, RECENT_MS } from '../../../main/hid/hid-facts'
import { freshnessView } from './hid-view'

/** The Reports card as the user sees it: main's verdicts (R3.3), coloured here. */
const freshness = (state: DeviceState, ageMs: number) =>
  freshnessView(isBoardPresent(state), freshnessBand(ageMs))

const MIN = 60 * 1000

describe('report freshness', () => {
  it('never shows a fault colour for silence while the link is up', () => {
    // The gateway sends a HID report only when a control changes, so a cockpit nobody is
    // touching sends nothing. A fault colour here would cry wolf every time the user let go of
    // the stick, and the user would learn to ignore it — including when it meant something.
    for (const ageMs of [0, 5 * MIN, 30 * MIN, 6 * 60 * MIN, Number.MAX_SAFE_INTEGER]) {
      expect(freshness('connected', ageMs).cls, `age ${ageMs}`).not.toBe('rate--down')
    }
  })

  it('reserves red for the board being absent, when nothing could arrive', () => {
    // Every state in which the board is not found, including the ones a pulled cable produces.
    // The original version keyed on whether the *relay* was running, which stays true while it
    // retries — so unplugging aged the card through its bands to 'quiet', claiming the device
    // had nothing to say when in fact it could not say anything.
    for (const state of ['reconnecting', 'no-device', 'scanning'] as const) {
      expect(freshness(state, 0).cls, state).toBe('rate--down')
      expect(freshness(state, 0).label, state).toBe('no link')
    }
    // A report a moment ago does not soften it: the board is gone now.
    expect(freshness('reconnecting', 1).cls).toBe('rate--down')
    // And a live link is not red, however old the last report.
    expect(freshness('connected', Number.MAX_SAFE_INTEGER).cls).not.toBe('rate--down')
  })

  it('keeps the joystick live while the serial port is released or busy (#74)', () => {
    // The HID interface is read alongside DCS and does not need the serial link. Disconnect,
    // auto-connect off, and another tool holding the port all leave the board plugged in and
    // the axes moving — red "no link" over them would say the opposite of what is on screen.
    for (const state of ['disconnected', 'error'] as const) {
      expect(freshness(state, 0).cls, state).toBe('rate--live')
      expect(freshness(state, RECENT_MS).cls, state).toBe('rate--stale')
    }
  })

  it('steps down through the bands as reports age', () => {
    expect(freshness('connected', 0).cls).toBe('rate--live')
    expect(freshness('connected', FRESH_MS - 1).cls).toBe('rate--live')
    expect(freshness('connected', FRESH_MS).cls, 'boundary belongs to the older band').toBe(
      'rate--idle'
    )
    expect(freshness('connected', RECENT_MS - 1).cls).toBe('rate--idle')
    expect(freshness('connected', RECENT_MS).cls).toBe('rate--stale')
  })

  it('is measured in minutes, not seconds', () => {
    // An axis untouched for a few seconds is being held still, not failing — the first band has
    // to outlast ordinary use. This pins the intent rather than the number, which has already
    // moved once.
    expect(FRESH_MS).toBeGreaterThanOrEqual(MIN)
    expect(RECENT_MS).toBeGreaterThan(FRESH_MS)
  })
})
