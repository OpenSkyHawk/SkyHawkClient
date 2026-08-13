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

/** Feed a value and hold it long enough to commit, the way a user reaching a stop would. */
function holdAt(s: CaptureState, value: number, from: number, ms = C.endpointHoldMs + 1) {
  let next = push(s, { t: from, raw: value })
  next = tick(next, from + ms)
  return next
}

/** One complete sweep: a stop, the other stop, and — if asked for — a release. */
function sweep(
  s: CaptureState,
  { lo, hi, centre, t = s.now }: { lo: number; hi: number; centre?: number; t?: number }
) {
  let next = holdAt(s, hi, t + 100)
  next = holdAt(next, lo, next.now + 100)
  if (centre !== undefined && next.step === 'centre') {
    next = push(next, { t: next.now + 100, raw: centre })
    next = tick(next, next.now + C.centreStableMs + 1)
  }
  return next
}

describe('the stability detector', () => {
  it('completes on wall clock, not on a sample count', () => {
    // The measurement this whole design turns on: the node emits only on change, so a settled
    // axis sends nothing. One sample then silence must still complete the hold.
    let s = beginCapture(0)
    s = push(s, { t: 0, raw: 50000 })
    expect(s.current.stopA).toBeUndefined()
    s = tick(s, C.endpointHoldMs + 1)
    expect(s.current.stopA, 'silence must not stall the hold').toBe(50000)
  })

  it('is not restarted by noise inside the band', () => {
    // Rest spread measured at 387 counts peak-to-peak, arriving ~1/s. If that restarted the
    // timer the hold would race the noise and sometimes never finish.
    let s = beginCapture(0)
    s = push(s, { t: 0, raw: 50000 })
    for (let i = 1; i <= 4; i++) s = push(s, { t: i * 250, raw: 50000 + (i % 2 ? 190 : -190) })
    expect(s.interruptions).toBe(0)
    s = tick(s, C.endpointHoldMs + 1)
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
    // A spike is rejected by construction: it restarts the clock, the value returns, and the
    // hold completes on the settled reading. No separate outlier filter exists or is needed.
    let s = beginCapture(0)
    s = push(s, { t: 0, raw: 50000 })
    s = push(s, { t: 300, raw: 61000 }) // spike
    s = push(s, { t: 320, raw: 50040 }) // and gone
    s = tick(s, 320 + C.endpointHoldMs + 1)
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
    s = holdAt(s, 13000, 100)
    s = holdAt(s, 51000, s.now + 100)
    s = push(s, { t: s.now + 100, raw: 32000 })
    s = tick(s, s.now + C.centreStableMs + 1)
    expect(s.accepted[0]).toEqual(lowFirst.accepted[0])
  })

  it('asks a self-centring axis to release, and a non-centring one not to', () => {
    let spring = beginCapture(0, true)
    spring = holdAt(spring, 51000, 100)
    spring = holdAt(spring, 13000, spring.now + 100)
    expect(spring.step, 'a rest position exists, so capture it').toBe('centre')

    let free = beginCapture(0, false)
    free = holdAt(free, 51000, 100)
    free = holdAt(free, 13000, free.now + 100)
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

  it('tolerates a small shortfall', () => {
    let s = beginCapture(0, false)
    s = sweep(s, { lo: 13000, hi: 51000 }) // travel 38000, slack 3800
    s = sweep(s, { lo: 15000, hi: 51000 }) // 2000 short — within slack
    expect(s.phase).toBe('capturing')
    expect(s.accepted).toHaveLength(2)
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
    for (const [lo, hi] of [
      [0, 65535],
      [13443, 50704],
      [30000, 30002],
      [1, 3]
    ]) {
      let s = beginCapture(0, false)
      for (let i = 0; i < 3; i++) s = sweep(s, { lo: lo!, hi: hi! })
      const r = s.result!
      expect(r.min, `${lo}..${hi}`).toBeLessThan(r.centre)
      expect(r.centre, `${lo}..${hi}`).toBeLessThan(r.max)
    }
  })
})

describe('centre capture', () => {
  it('finishes early once the value is stable', () => {
    let s = beginCapture(0, true)
    s = holdAt(s, 51000, 100)
    s = holdAt(s, 13000, s.now + 100)
    expect(s.step).toBe('centre')
    const t = s.now
    s = push(s, { t: t + 50, raw: 32000 })
    s = tick(s, t + 50 + C.centreStableMs + 1)
    expect(s.accepted[0]!.centre, 'stable for 5 s is enough').toBe(32000)
  })

  it('gives up at the cap and averages what arrived', () => {
    // A stick that keeps twitching outside the band would otherwise never finish. Averaging the
    // window beats stranding the user mid-capture.
    let s = beginCapture(0, true)
    s = holdAt(s, 51000, 100)
    s = holdAt(s, 13000, s.now + 100)
    const t = s.now
    for (let i = 1; i <= 10; i++) {
      s = push(s, { t: t + i * 1000, raw: i % 2 ? 31000 : 33000 }) // never settles
    }
    s = tick(s, t + C.centreCapMs + 1)
    expect(s.accepted[0]!.centre).toBe(32000)
  })
})
