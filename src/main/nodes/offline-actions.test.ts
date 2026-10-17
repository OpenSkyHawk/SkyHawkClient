import { describe, expect, it } from 'vitest'
import type { NodeTelemSnapshot } from '@shared/nodes'
import {
  canForget,
  canHide,
  NO_ROSTER_NOTE,
  offlineRefusal,
  ONLINE_NOTE,
  pduTelemetryLive
} from './offline-actions'

const page = (stale: boolean) => ({
  kind: 'rail' as const,
  page: 1 as const,
  flags: 0,
  vAvgMv: 12_000,
  vMinMv: 11_980,
  iAvgMa: 500,
  ageMs: stale ? 9000 : 500,
  stale
})
const telem = (nodeId: number, stale: boolean): NodeTelemSnapshot => ({
  nodeId,
  isPdu: true,
  rail12V: page(stale),
  other: [],
  live: !stale
})

describe('canHide / canForget (M1/C3: offline only, by the one availability rule)', () => {
  for (const gate of [canHide, canForget]) {
    it(`${gate.name}: allowed only offline with no fresh PDU pages`, () => {
      expect(gate({ availability: 'offline', pduTelemetry: false })).toEqual({ ok: true })
      expect(gate({ availability: 'online', pduTelemetry: false })).toEqual({
        ok: false,
        why: 'online',
        note: ONLINE_NOTE
      })
      // Just after a reconnect: not known, so not offline.
      expect(gate({ availability: 'unknown', pduTelemetry: false })).toEqual({
        ok: false,
        why: 'no-roster',
        note: NO_ROSTER_NOTE
      })
      // Fresh PDU pages prove it live, whatever the roster says.
      for (const availability of ['offline', 'unknown'] as const) {
        expect(gate({ availability, pduTelemetry: true })).toMatchObject({
          ok: false,
          why: 'online'
        })
      }
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

  it('PDU pages count only while fresh, and only for that NODE_ID', () => {
    expect(pduTelemetryLive([telem(4, false)], 4)).toBe(true)
    expect(pduTelemetryLive([telem(4, true)], 4)).toBe(false)
    expect(pduTelemetryLive([telem(4, false)], 3)).toBe(false)
    expect(pduTelemetryLive([], 4)).toBe(false)
  })
})
