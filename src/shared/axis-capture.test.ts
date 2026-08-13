import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CAPTURE_CONFIG,
  beginCapture,
  holdProgress,
  midpoint,
  push,
  reconcile,
  retrySweep,
  sweepsRemaining,
  tick,
  type CaptureState
} from './axis-capture'

const C = DEFAULT_CAPTURE_CONFIG

/**
 * Move the axis from `from` to `to`, then hold there long enough to commit.
 *
 * The journey matters, not just the destination. A hold proves nothing unless the axis actually
 * travelled during that step — otherwise the capture commits wherever it happened to be sitting
 * when the step opened, which is exactly the bug this models.
 *
 * Two samples at the destination, not one: a real hold is not silent. Measured rest noise is 387
 * counts peak-to-peak, over the node's 128-count emission threshold, so readings keep arriving at
 * roughly 1/s. The second is that noise, and it confirms the value is a genuine hold rather than
 * a lone reading whose successor was dropped.
 */
function moveAndHold(
  s: CaptureState,
  from: number,
  to: number,
  hold = C.endpointHoldMs + 1
): CaptureState {
  let next = push(s, { t: s.now + 50, raw: from })
  next = push(next, { t: next.now + 150, raw: to })
  next = push(next, { t: next.now + 200, raw: to + 150 })
  return tick(next, next.now + hold)
}

/** One complete sweep: a stop, the other stop, and — if asked for — a release to rest. */
function sweep(
  s: CaptureState,
  { lo, hi, centre, park = 32000 }: { lo: number; hi: number; centre?: number; park?: number }
) {
  let next = moveAndHold(s, park, hi)
  next = moveAndHold(next, hi, lo)
  if (centre !== undefined && next.step === 'centre') {
    next = moveAndHold(next, lo, centre, C.centreStableMs + 1)
  }
  return next
}

describe('the movement gate', () => {
  it('will not commit a value the axis never moved to', () => {
    // The bug this exists for: capture opens, the axis is sitting at rest, noise arrives, the
    // value holds for a second — and the rest position gets committed as the first stop before
    // the user has touched anything.
    let s = beginCapture(0)
    s = push(s, { t: 0, raw: 32000 })
    s = push(s, { t: 200, raw: 32150 }) // noise, well under minTravelCounts
    s = tick(s, C.endpointHoldMs + 1)
    expect(s.current.stopA, 'sitting still must capture nothing').toBeUndefined()
    expect(s.awaitingMovement, 'and the UI must be able to say why').toBe(true)
  })

  it('commits once the axis has actually travelled', () => {
    let s = beginCapture(0)
    s = push(s, { t: 0, raw: 32000 })
    s = push(s, { t: 400, raw: 51000 }) // swept to a stop
    s = push(s, { t: 600, raw: 51120 })
    s = tick(s, 600 + C.endpointHoldMs + 1)
    expect(s.current.stopA).toBe(51000)
    expect(s.awaitingMovement).toBe(false)
  })

  it('requires movement again for each point, not once per sweep', () => {
    // Otherwise the second stop would commit the moment the first one did, since the axis is
    // already sitting somewhere that has "moved" relative to the start of the capture.
    let s = beginCapture(0)
    s = push(s, { t: 0, raw: 32000 })
    s = push(s, { t: 400, raw: 51000 })
    s = push(s, { t: 600, raw: 51120 })
    s = tick(s, 600 + C.endpointHoldMs + 1)
    expect(s.step).toBe('stopB')

    // Still at the first stop, not moving. Must not commit stopB.
    s = push(s, { t: 2000, raw: 51050 })
    s = push(s, { t: 2200, raw: 51180 })
    s = tick(s, 2200 + C.endpointHoldMs + 1)
    expect(s.current.stopB, 'the axis has not gone anywhere new').toBeUndefined()
  })
})

describe('the stability detector', () => {
  it('completes on wall clock, not on a sample count', () => {
    // The measurement this design turns on: the node emits only on change, so a hold produces
    // a trickle of noise readings, never a steady stream. Two samples and then silence must
    // complete the hold — the elapsed time does the work, not the count.
    let s = beginCapture(0)
    s = push(s, { t: 0, raw: 32000 }) // where it started
    s = push(s, { t: 100, raw: 50000 }) // swept to the stop — the hold clock starts here
    s = push(s, { t: 300, raw: 50150 })
    expect(s.current.stopA, 'not yet — the hold time has not elapsed').toBeUndefined()
    s = tick(s, 100 + C.endpointHoldMs + 1)
    expect(s.current.stopA, 'silence after confirmation must not stall the hold').toBe(50000)
  })

  it('will not commit a value nothing has confirmed', () => {
    // The dropped-return spike. RAW is explicitly droppable under CDC back-pressure, so
    // settled -> spike -> (return frame lost) leaves the spike as the reference with nothing
    // following it. Committing on elapsed time alone would write it to flash, and widest-wins
    // would then protect it over every good sweep.
    //
    // The SEQ gap cannot save us here: a gap is only visible on the next arriving frame, and in
    // this sequence none arrives.
    let s = beginCapture(0)
    s = push(s, { t: 0, raw: 50000 })
    s = push(s, { t: 200, raw: 50150 }) // settled and confirmed
    s = push(s, { t: 400, raw: 61000 }) // spike; its return frame is dropped
    s = tick(s, 400 + C.endpointHoldMs + 1)

    expect(s.current.stopA, 'a lone spike must never be committed').toBeUndefined()
    expect(s.awaitingConfirmation, 'and the UI must be able to explain the wait').toBe(true)
  })

  it('commits once a confirming sample finally arrives', () => {
    let s = beginCapture(0)
    s = push(s, { t: 0, raw: 32000 })
    s = push(s, { t: 100, raw: 50000 })
    s = tick(s, 100 + C.endpointHoldMs + 1)
    expect(s.awaitingConfirmation).toBe(true)
    s = push(s, { t: 100 + C.endpointHoldMs + 200, raw: 50120 })
    expect(s.current.stopA, 'confirmation releases the already-elapsed hold').toBe(50000)
    expect(s.awaitingConfirmation).toBe(false)
  })

  it('is not restarted by noise inside the band', () => {
    // Rest spread measured at 387 counts peak-to-peak, arriving ~1/s. If that restarted the
    // timer the hold would race the noise and sometimes never finish.
    let s = beginCapture(0)
    s = push(s, { t: 0, raw: 32000 })
    s = push(s, { t: 100, raw: 50000 }) // hold clock starts here
    // The sweep itself counts as one — it interrupted whatever was being timed before. What
    // must not add more is the noise that follows while the axis is held.
    const afterSweep = s.interruptions
    for (let i = 1; i <= 3; i++)
      s = push(s, { t: 100 + i * 200, raw: 50000 + (i % 2 ? 190 : -190) })
    expect(s.interruptions, 'in-band noise is not movement').toBe(afterSweep)
    s = tick(s, 100 + C.endpointHoldMs + 1)
    expect(s.current.stopA, 'noise must not prevent a hold from completing').toBe(50000)
  })

  it('is restarted by movement beyond the band', () => {
    let s = beginCapture(0)
    s = push(s, { t: 0, raw: 50000 })
    s = push(s, { t: 500, raw: 50000 + C.bandCounts + 1 })
    expect(s.interruptions).toBe(1)
    s = tick(s, 900) // 900 ms after the *original* value, only 400 ms after the new one
    expect(s.current.stopA, 'the clock must restart, not carry over').toBeUndefined()
  })

  it('never lets a spike become an endpoint', () => {
    // The ordinary case, where the return frame is delivered: the spike restarts the clock, the
    // value returns, and the hold completes on the settled reading. No separate outlier filter
    // is needed for this. The case where the return frame is *dropped* is covered above by the
    // corroboration requirement — that one is not handled by this mechanism at all.
    let s = beginCapture(0)
    s = push(s, { t: 0, raw: 50000 })
    s = push(s, { t: 300, raw: 61000 }) // spike
    s = push(s, { t: 320, raw: 50040 }) // and gone
    s = push(s, { t: 520, raw: 50100 }) // settled again, and confirmed
    s = tick(s, 520 + C.endpointHoldMs + 1)
    expect(s.current.stopA).toBe(50040)
    expect(s.current.stopA).not.toBe(61000)
    expect(s.interruptions, 'the interruption is worth surfacing to the user').toBe(2)
  })

  it('reports hold progress for the UI without deciding anything', () => {
    let s = beginCapture(0)
    s = push(s, { t: 0, raw: 40000 })
    s = tick(s, C.endpointHoldMs / 2)
    expect(holdProgress(s)).toBeCloseTo(0.5, 2)
  })
})

describe('sweep flow', () => {
  it('does not care which stop is reached first', () => {
    const lowFirst = sweep(beginCapture(0), { lo: 13000, hi: 51000, centre: 32000 })
    let s = beginCapture(0)
    s = moveAndHold(s, 32000, 13000)
    s = moveAndHold(s, 13000, 51000)
    s = moveAndHold(s, 51000, 32000, C.centreStableMs + 1)
    expect(s.accepted[0]).toEqual(lowFirst.accepted[0])
  })

  it('asks a self-centring axis to release, and a non-centring one not to', () => {
    let spring = beginCapture(0, true)
    spring = moveAndHold(spring, 32000, 51000)
    spring = moveAndHold(spring, 51000, 13000)
    expect(spring.step, 'a rest position exists, so capture it').toBe('centre')

    let free = beginCapture(0, false)
    free = moveAndHold(free, 32000, 51000)
    free = moveAndHold(free, 51000, 13000)
    expect(free.accepted, 'no rest position, so the sweep is already done').toHaveLength(1)
    expect(free.accepted[0]!.centre).toBeUndefined()
  })

  it('needs three accepted sweeps', () => {
    let s = beginCapture(0, false)
    expect(sweepsRemaining(s)).toBe(3)
    s = sweep(s, { lo: 13000, hi: 51000 })
    expect(sweepsRemaining(s)).toBe(2)
    s = sweep(s, { lo: 13000, hi: 51000 })
    s = sweep(s, { lo: 13000, hi: 51000 })
    expect(s.phase).toBe('complete')
    expect(s.result).toBeDefined()
  })
})

describe('accept and reject', () => {
  it('accepts a wider sweep, always', () => {
    // Travel can only be under-reported: a stop is fixed, so you cannot push past it. Reaching
    // wider is a better swing, never an anomaly.
    let s = beginCapture(0, false)
    s = sweep(s, { lo: 20000, hi: 45000 })
    s = sweep(s, { lo: 13000, hi: 51000 })
    expect(s.phase).toBe('capturing')
    expect(s.accepted).toHaveLength(2)
  })

  it('rejects a sweep that falls materially short, and keeps the good ones', () => {
    let s = beginCapture(0, false)
    s = sweep(s, { lo: 13000, hi: 51000 })
    s = sweep(s, { lo: 25000, hi: 51000 }) // 12000 short on the low end
    expect(s.phase).toBe('rejected')
    expect(s.rejection).toMatch(/low end/)
    expect(s.accepted, 'banked sweeps survive a rejection').toHaveLength(1)

    s = retrySweep(s, s.now)
    expect(s.phase).toBe('capturing')
    expect(s.step).toBe('stopA')
    s = sweep(s, { lo: 13000, hi: 51000 })
    expect(s.accepted).toHaveLength(2)
  })

  it('rejects a shortfall on the high end too', () => {
    let s = beginCapture(0, false)
    s = sweep(s, { lo: 13000, hi: 51000 })
    s = sweep(s, { lo: 13000, hi: 40000 })
    expect(s.rejection).toMatch(/high end/)
  })

  it('tolerates the variation two honest swings actually show', () => {
    // Not a hypothetical: these are two real sweeps of the same bench axis, minutes apart. The
    // shortfall between them is 6.9% on min and 5.4% on max, so a threshold anywhere near 10%
    // would reject a swing the user did nothing wrong on.
    let s = beginCapture(0, false)
    s = sweep(s, { lo: 13973, hi: 50925 })
    s = sweep(s, { lo: 16538, hi: 48933 })
    expect(s.phase, 'real swing-to-swing variation must not be rejected').toBe('capturing')
    expect(s.accepted).toHaveLength(2)
  })

  it('pins the shortfall threshold on both sides of the boundary', () => {
    // travel 38000, so the slack is 5700 at 15%.
    const inside = sweep(sweep(beginCapture(0, false), { lo: 13000, hi: 51000 }), {
      lo: 18500, // 5500 short — just inside
      hi: 51000
    })
    expect(inside.phase, '5500 of 5700 slack').toBe('capturing')

    const outside = sweep(sweep(beginCapture(0, false), { lo: 13000, hi: 51000 }), {
      lo: 19000, // 6000 short — just outside
      hi: 51000
    })
    expect(outside.phase, '6000 exceeds 5700 slack').toBe('rejected')
  })

  it('supersedes a short first sweep instead of rejecting it', () => {
    // The first sweep has nothing to be judged against, and it does not need to be: it is
    // banked, a fuller sweep is "wider so accept", and widest-wins picks the good one. This is
    // why no within-sweep guard is required.
    let s = beginCapture(0, false)
    s = sweep(s, { lo: 30000, hi: 35000 }) // barely moved
    expect(s.phase, 'the first sweep is never rejected').toBe('capturing')
    s = sweep(s, { lo: 13000, hi: 51000 })
    s = sweep(s, { lo: 13100, hi: 50900 })
    expect(s.result).toMatchObject({ min: 13000, max: 51000 })
  })
})

describe('reconciliation', () => {
  it('takes the widest accepted endpoints', () => {
    // Every reading is at or below the true extreme, so widest is closest to truth and still
    // inside it — biased inward, as #46 requires, without a separate rule.
    let s = beginCapture(0, false)
    s = sweep(s, { lo: 14000, hi: 50000 })
    s = sweep(s, { lo: 13000, hi: 50500 })
    s = sweep(s, { lo: 13500, hi: 51000 })
    expect(s.result).toMatchObject({ min: 13000, max: 51000 })
  })

  it('averages the captured centres', () => {
    let s = beginCapture(0, true)
    s = sweep(s, { lo: 13000, hi: 51000, centre: 32000 })
    s = sweep(s, { lo: 13000, hi: 51000, centre: 32300 })
    s = sweep(s, { lo: 13000, hi: 51000, centre: 32100 })
    expect(s.result!.centre).toBe(32133)
  })

  it('defaults centre to the midpoint when none was captured', () => {
    let s = beginCapture(0, false)
    s = sweep(s, { lo: 13000, hi: 51000 })
    s = sweep(s, { lo: 13000, hi: 51000 })
    s = sweep(s, { lo: 13000, hi: 51000 })
    expect(s.result!.centre).toBe(32000)
    expect(s.result!.centre).toBe(midpoint(13000, 51000))
  })

  it('rounds the midpoint rather than truncating', () => {
    expect(midpoint(13443, 50704)).toBe(32074) // 32073.5
  })

  it('can be asked for a running result before the sweeps are done', () => {
    // Exported so the dialog can show what would be committed so far, which is why it must work
    // on a partial state and not only on the finished one.
    let s = beginCapture(0, false)
    s = sweep(s, { lo: 14000, hi: 50000 })
    expect(s.phase, 'still mid-capture').toBe('capturing')
    expect(reconcile(s)).toEqual({ min: 14000, centre: 32000, max: 50000 })
    s = sweep(s, { lo: 13000, hi: 51000 })
    expect(reconcile(s)).toMatchObject({ min: 13000, max: 51000 })
  })

  it('always yields min < centre < max, which the device requires', () => {
    // Exercised through reconcile rather than a captured flow, so the degenerate spans stay
    // covered: an axis narrower than minTravelCounts cannot be captured at all, by design.
    for (const [lo, hi] of [
      [0, 65535],
      [13443, 50704],
      [30000, 30002],
      [1, 3]
    ]) {
      const state = {
        ...beginCapture(0, false),
        accepted: [{ min: lo!, max: hi! }]
      }
      const r = reconcile(state)
      expect(r.min, `${lo}..${hi}`).toBeLessThan(r.centre)
      expect(r.centre, `${lo}..${hi}`).toBeLessThan(r.max)
    }
  })

  it('cannot capture an axis with less travel than the movement gate', () => {
    // A deliberate consequence, recorded rather than discovered later: the gate is what stops a
    // resting axis being committed, so an axis that never moves further than it is not
    // distinguishable from one sitting still.
    // Kept clear of the gate including the noise sample moveAndHold adds, so the test measures
    // the gate rather than the helper.
    let s = beginCapture(0, false)
    s = moveAndHold(s, 32000, 32000 + C.minTravelCounts - 300)
    expect(s.current.stopA).toBeUndefined()
    expect(s.awaitingMovement).toBe(true)
  })
})

describe('centre capture', () => {
  it('finishes early once the value is stable', () => {
    let s = beginCapture(0, true)
    s = moveAndHold(s, 32000, 51000)
    s = moveAndHold(s, 51000, 13000)
    expect(s.step).toBe('centre')
    const t = s.now
    s = push(s, { t: t + 50, raw: 13000 }) // released from the stop
    s = push(s, { t: t + 150, raw: 32000 })
    s = push(s, { t: t + 450, raw: 32130 }) // in-band noise confirms the rest position
    s = tick(s, t + 450 + C.centreStableMs + 1)
    expect(s.accepted[0]!.centre, 'stable for 5 s is enough').toBe(32000)
  })

  it('gives up at the cap and averages what arrived', () => {
    // A stick that keeps twitching outside the band would otherwise never finish. Averaging the
    // window beats stranding the user mid-capture.
    let s = beginCapture(0, true)
    s = moveAndHold(s, 32000, 51000)
    s = moveAndHold(s, 51000, 13000)
    const t = s.now
    for (let i = 1; i <= 10; i++) {
      s = push(s, { t: t + i * 1000, raw: i % 2 ? 31000 : 33000 }) // never settles
    }
    s = tick(s, t + C.centreCapMs + 1)
    // No exact answer exists for an axis that never settles — the fallback is an estimate, so
    // assert the neighbourhood rather than pretending to a precision it does not have.
    expect(s.accepted[0]!.centre).toBeGreaterThan(31500)
    expect(s.accepted[0]!.centre).toBeLessThan(32500)
  })

  it('excludes the release transit from the capped-out average', () => {
    // The bug this exists for. Collection starts the instant stopB commits, so the first
    // readings are the spring travelling from the mechanical stop back toward rest. Averaging
    // that trajectory in drags the stored centre toward the stop the user last held.
    //
    // The earlier test could not catch it: it alternated symmetrically about centre, so the
    // transit and the rest readings happened to average to the same number.
    let s = beginCapture(0, true)
    s = moveAndHold(s, 32000, 51000)
    s = moveAndHold(s, 51000, 13000) // last stop is the LOW end
    const t = s.now

    // One-directional climb away from that stop, then noisy rest near 32000 that never settles
    // inside the band for a full 5 s.
    const transit = [14000, 18000, 23000, 28000]
    transit.forEach((raw, i) => (s = push(s, { t: t + (i + 1) * 400, raw })))
    let at = t + 2000
    for (let i = 0; i < 12; i++) {
      at += 1000
      s = push(s, { t: at, raw: i % 2 ? 31400 : 32600 })
    }
    s = tick(s, t + C.centreCapMs + 1)

    const centre = s.accepted[0]!.centre!
    const naive = Math.round([...transit, ...Array(12).fill(32000)].reduce((a, b) => a + b, 0) / 16)
    expect(centre, 'transit must not be averaged in').toBeGreaterThan(naive)
    expect(centre, 'the answer is the rest cluster').toBeGreaterThan(31000)
    expect(centre).toBeLessThan(33000)
  })
})
