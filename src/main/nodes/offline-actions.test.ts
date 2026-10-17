import { describe, expect, it } from 'vitest'
import { canForget, canHide, NO_ROSTER_NOTE, offlineRefusal, ONLINE_NOTE } from './offline-actions'

describe('canHide / canForget (M1/C3: offline only, by the one availability rule)', () => {
  for (const gate of [canHide, canForget]) {
    it(`${gate.name}: allowed only offline`, () => {
      expect(gate({ availability: 'offline' })).toEqual({ ok: true })
      expect(gate({ availability: 'online' })).toEqual({
        ok: false,
        why: 'online',
        note: ONLINE_NOTE
      })
      // Just after a reconnect: not known, so not offline.
      expect(gate({ availability: 'unknown' })).toEqual({
        ok: false,
        why: 'no-roster',
        note: NO_ROSTER_NOTE
      })
      // A PDU's fresh pages are weighed in the availability itself (node-model.ts
      // availabilityOf, the newest evidence wins), so the gate reads nothing else.
    })
  }

  it('main’s refusal: the online wording it always had, the footer’s reason before a roster', () => {
    expect(offlineRefusal('online', 'forgotten')).toBe(
      'It is online — a board on the bus can’t be forgotten'
    )
    expect(offlineRefusal('online', 'hidden')).toBe(
      'It is online — a board on the bus can’t be hidden'
    )
    expect(offlineRefusal('no-roster', 'forgotten')).toBe(
      'No roster yet — connect the Gateway. Forget and Hide work once the board shows offline.'
    )
  })
})
