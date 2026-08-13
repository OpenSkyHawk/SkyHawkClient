import { describe, expect, it } from 'vitest'
import type { CalSnapshot } from './ipc'
import {
  boardFor,
  dropAxis,
  emptyCache,
  regressedAxes,
  sanitizeCache,
  storeAxes,
  type CachedAxis,
  type CalCache
} from './cal-cache'

const SERIAL = '50031327805E871C'
const axis = (over: Partial<CachedAxis> = {}): CachedAxis => ({
  min: 13000,
  centre: 32000,
  max: 51000,
  selfCentring: true,
  ...over
})

/**
 * `calibrated` and `present` are what the rules key on; the rest is filler.
 *
 * The serial is a required argument with no default on purpose: a default would be applied to an
 * explicit `undefined`, so the "no serial" tests would silently run against a known board — which
 * is exactly what happened when this had one.
 */
function snapshot(
  axes: Partial<Record<number, { present: boolean; calibrated: boolean }>>,
  serialNumber: string | undefined
): CalSnapshot {
  return {
    presentMask: 0,
    calibratedMask: 0,
    serialNumber,
    axes: Array.from({ length: 8 }, (_, idx) => ({
      idx,
      controlId: 0,
      min: 0,
      centre: 0,
      max: 0,
      deadzone: 0,
      present: axes[idx]?.present ?? false,
      calibrated: axes[idx]?.calibrated ?? false
    }))
  }
}

describe('cache updates', () => {
  it('merges rather than replacing, so one axis does not erase the others', () => {
    let c = storeAxes(emptyCache(), SERIAL, { 0: axis() }, 'T1')
    c = storeAxes(c, SERIAL, { 1: axis({ min: 14000 }) }, 'T2')
    expect(Object.keys(boardFor(c, SERIAL)!.axes)).toEqual(['0', '1'])
    expect(boardFor(c, SERIAL)!.confirmedAt, 'the newest confirmation wins').toBe('T2')
  })

  it('refuses to store against an unknown board', () => {
    // Nothing identifies the board, so nothing can safely be filed under it later.
    const c = storeAxes(emptyCache(), '', { 0: axis() }, 'T1')
    expect(c).toEqual(emptyCache())
  })

  it('forgets an axis on delete, and the board once nothing is left', () => {
    let c = storeAxes(emptyCache(), SERIAL, { 0: axis(), 1: axis() }, 'T1')
    c = dropAxis(c, SERIAL, 0)
    expect(Object.keys(boardFor(c, SERIAL)!.axes)).toEqual(['1'])
    c = dropAxis(c, SERIAL, 1)
    expect(boardFor(c, SERIAL), 'an empty board is not a board').toBeUndefined()
  })
})

describe('regression detection', () => {
  it('reports an axis the device has lost', () => {
    const c = storeAxes(emptyCache(), SERIAL, { 0: axis(), 1: axis() }, 'T1')
    const s = snapshot(
      { 0: { present: true, calibrated: false }, 1: { present: true, calibrated: true } },
      SERIAL
    )
    expect(regressedAxes(c, s), 'only the one the device no longer holds').toEqual([0])
  })

  it('says nothing without a serial', () => {
    // Hall sensors vary per unit, so calibration from an unidentified board could belong to any
    // board. Restoring it would fail open — a plausible calibration that is wrong for the
    // hardware, and invisible, unlike the uncalibrated state it replaced.
    const c = storeAxes(emptyCache(), SERIAL, { 0: axis() }, 'T1')
    expect(
      regressedAxes(c, snapshot({ 0: { present: true, calibrated: false } }, undefined))
    ).toEqual([])
    expect(regressedAxes(c, snapshot({ 0: { present: true, calibrated: false } }, ''))).toEqual([])
  })

  it('will not match an empty-serial entry to a device that reports no serial', () => {
    // Neither storeAxes nor sanitizeCache can currently produce a board filed under '', so this
    // constructs it directly. The guard is kept because it protects the worst failure this feature
    // has — writing one board's endpoints onto another — and that should not depend on two other
    // functions continuing to agree. Without it, '' matches '' and the offer appears.
    const c: CalCache = {
      version: 1,
      boards: { '': { confirmedAt: 'T1', axes: { 0: axis() } } }
    }
    expect(boardFor(c, ''), 'an unidentified board is not a board').toBeUndefined()
    expect(boardFor(c, undefined)).toBeUndefined()
    expect(regressedAxes(c, snapshot({ 0: { present: true, calibrated: false } }, ''))).toEqual([])
  })

  it('says nothing about a different board', () => {
    const c = storeAxes(emptyCache(), SERIAL, { 0: axis() }, 'T1')
    const other = snapshot({ 0: { present: true, calibrated: false } }, 'OTHER-BOARD')
    expect(regressedAxes(c, other)).toEqual([])
  })

  it('ignores a slot the device no longer declares', () => {
    // Not a loss — a different cockpit. Offering to write calibration into a slot the sketch does
    // not use would be noise, and the axis is not awaiting anything.
    const c = storeAxes(emptyCache(), SERIAL, { 0: axis() }, 'T1')
    expect(
      regressedAxes(c, snapshot({ 0: { present: false, calibrated: false } }, SERIAL))
    ).toEqual([])
  })
})

describe('reading the file back', () => {
  it('keeps a well-formed entry, including the rest position', () => {
    const c = storeAxes(emptyCache(), SERIAL, { 0: axis({ selfCentring: false }) }, 'T1')
    const back = sanitizeCache(JSON.parse(JSON.stringify(c)))
    expect(back.boards[SERIAL]!.axes[0]).toEqual(axis({ selfCentring: false }))
  })

  it('drops an entry the device would refuse rather than repairing it', () => {
    // A repaired endpoint is a plausible wrong number, which is the thing this cache exists to
    // avoid pushing onto a device. Ordering is the same rule COMMIT enforces, so an entry that
    // fails it would otherwise survive as far as the restore offer and then fail at the wire.
    const bad = {
      version: 1,
      boards: {
        [SERIAL]: {
          confirmedAt: 'T1',
          axes: {
            0: { min: 40000, centre: 32000, max: 51000, selfCentring: true }, // centre below min
            1: { min: 13000, centre: 32000, max: 70000, selfCentring: true }, // max out of range
            2: { min: 13000, centre: 32000, max: 51000, selfCentring: true } // fine
          }
        }
      }
    }
    expect(Object.keys(sanitizeCache(bad).boards[SERIAL]!.axes)).toEqual(['2'])
  })

  it('returns an empty cache for junk, a wrong version, or nothing at all', () => {
    expect(sanitizeCache(undefined)).toEqual(emptyCache())
    expect(sanitizeCache('not an object')).toEqual(emptyCache())
    expect(sanitizeCache({ version: 2, boards: { [SERIAL]: {} } })).toEqual(emptyCache())
  })

  it('defaults a missing rest position to self-centring, matching capture', () => {
    const raw = {
      version: 1,
      boards: { [SERIAL]: { confirmedAt: 'T1', axes: { 0: { min: 1, centre: 2, max: 3 } } } }
    }
    expect(sanitizeCache(raw).boards[SERIAL]!.axes[0]!.selfCentring).toBe(true)
  })
})
