import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CAPTURE_CONFIG, midpoint } from '@shared/axis-capture'
import type { CalRawSample, CalResult, CalSnapshot } from '@shared/ipc'
import { CalibrationController, type CalibrationApi } from './calibration-controller'

const C = DEFAULT_CAPTURE_CONFIG

const snapshot = (axes: Partial<Record<number, { min: number; centre: number; max: number }>>) =>
  ({
    presentMask: 0b11,
    calibratedMask: Object.keys(axes).reduce((m, k) => m | (1 << Number(k)), 0),
    serialNumber: 'BOARD-A',
    axes: Array.from({ length: 8 }, (_, idx) => ({
      idx,
      controlId: idx < 2 ? 0x10 + idx : 0,
      min: axes[idx]?.min ?? 0,
      centre: axes[idx]?.centre ?? 0,
      max: axes[idx]?.max ?? 0,
      deadzone: 0,
      present: idx < 2,
      calibrated: axes[idx] !== undefined
    }))
  }) satisfies CalSnapshot

const ok = <T>(value: T): CalResult<T> => ({ ok: true, value })

/** A device that stores what it is told, so the read-back is a real round trip. */
function fakeDevice() {
  const stored: Record<number, { min: number; centre: number; max: number }> = {}
  const calls: string[] = []
  const fail: { commit?: CalResult<null>; read?: CalResult<CalSnapshot>; reset?: CalResult<null> } =
    {}

  const api: CalibrationApi = {
    calRead: async () => {
      calls.push('read')
      return fail.read ?? ok(snapshot(stored))
    },
    calSessionOpen: async (axisIdx) => {
      calls.push(`open:${axisIdx}`)
      return ok({ timeoutMs: 30000, axisIdx })
    },
    calStreamSelect: async (axisIdx) => {
      calls.push(`select:${axisIdx}`)
      return ok(null)
    },
    calCommit: async (a) => {
      calls.push(`commit:${a.idx}`)
      if (fail.commit) return fail.commit
      stored[a.idx] = { min: a.min, centre: a.centre, max: a.max }
      return ok(null)
    },
    calReset: async (idx) => {
      calls.push(`reset:${idx}`)
      if (fail.reset) return fail.reset
      delete stored[idx]
      return ok(null)
    },
    calSessionClose: async () => {
      calls.push('close')
      return ok(null)
    }
  }
  return { api, stored, calls, fail }
}

let clock = 0
const now = () => clock

function samples(idx: number, values: number[], step = 200): CalRawSample[] {
  return values.map((raw, i) => ({ t: clock + i * step, idx, raw, cal: raw }))
}

/**
 * Drive a full sweep the way a user's movements would — including the journey.
 *
 * The axis has to travel between points, not merely appear at them: a hold commits nothing
 * unless the step registered real movement, which is what stops a resting axis being captured
 * as a stop.
 */
async function sweep(c: CalibrationController, lo: number, hi: number, centre?: number) {
  const moveTo = (from: number, to: number, ms = C.endpointHoldMs + 200) => {
    c.ingest(samples(0, [from, to, to + 150]))
    clock += ms
    vi.advanceTimersByTime(ms)
  }
  moveTo(32000, hi)
  moveTo(hi, lo)
  if (centre !== undefined) moveTo(lo, centre, C.centreStableMs + 200)
  await Promise.resolve()
}

describe('CalibrationController', () => {
  beforeEach(() => {
    clock = 0
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('treats the session as open only once SESSION_ACK arrives', async () => {
    const d = fakeDevice()
    d.api.calSessionOpen = async () => ({
      ok: false,
      kind: 'nack',
      reason: 0x04,
      reasonName: 'BAD_INDEX',
      detail: 9,
      message: 'refused'
    })
    const c = new CalibrationController(d.api, now)
    await c.open(9)
    expect(c.snapshot().failure?.kind).toBe('nack')
    expect(c.snapshot().busy).toBe(false)
  })

  it('ignores samples for an axis it is not showing', () => {
    // A frame can be in flight across a STREAM_SELECT; RAW carries idx so it can be discarded.
    const d = fakeDevice()
    const c = new CalibrationController(d.api, now)
    c.startCapture()
    c.ingest(samples(3, [50000, 50100]))
    expect(c.snapshot().live, 'another axis must not drive the readout').toBeUndefined()
    expect(c.snapshot().capture?.current.stopA).toBeUndefined()
  })

  it('captures a full axis and banks it as a draft, writing nothing', async () => {
    const d = fakeDevice()
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    c.startCapture()
    await sweep(c, 13000, 51000, 32000)
    await sweep(c, 13000, 51000, 32000)
    await sweep(c, 13000, 51000, 32000)

    expect(c.dirtyAxes()).toEqual([0])
    expect(c.snapshot().drafts[0]).toMatchObject({ min: 13000, max: 51000 })
    expect(
      d.calls.filter((x) => x.startsWith('commit')),
      'capture must not write'
    ).toHaveLength(0)
  })

  it('banks the draft when the last hold completes on a sample, not on a tick', async () => {
    // A hold commits down either path — the ticker, when a settled axis has gone silent, or
    // `push`, when the sample that satisfies the dwell happens to be the one that arrives. The
    // sample path is what a user hits when the axis is still emitting noise at rest, and banking
    // only from the ticker stranded it: phase 'complete', no draft, Write greyed out on a
    // capture that had just finished. Here the clock advances without the interval firing, so
    // every commit lands on an arriving sample.
    const d = fakeDevice()
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    c.startCapture()
    await sweep(c, 13000, 51000, 32000)
    await sweep(c, 13000, 51000, 32000)

    const holdViaSample = (from: number, to: number, ms = C.endpointHoldMs + 200) => {
      c.ingest(samples(0, [from, to, to + 150]))
      clock += ms
      c.ingest(samples(0, [to + 100])) // in band, arriving late: this sample completes the hold
    }
    holdViaSample(32000, 51000)
    holdViaSample(51000, 13000)
    holdViaSample(13000, 32000, C.centreStableMs + 200)

    expect(c.snapshot().capture, 'a finished capture must not linger in state').toBeUndefined()
    expect(c.dirtyAxes(), 'the third sweep completed, so there is something to write').toEqual([0])
  })

  it('stays on the current axis when STREAM_SELECT is refused', async () => {
    // Switching optimistically would leave us filtering for an axis the gateway is not
    // streaming: every sample dropped on idx, so the readout and capture look dead. Worse, a
    // retry of the same axis would early-return as a no-op, with no way out.
    const d = fakeDevice()
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    d.api.calStreamSelect = async () => ({
      ok: false,
      kind: 'nack',
      reason: 0x06,
      reasonName: 'NO_SESSION',
      detail: 0xff,
      message: 'refused'
    })

    await c.selectAxis(1)
    expect(c.snapshot().axis, 'the device is still streaming axis 0').toBe(0)
    expect(c.snapshot().switchingTo).toBeUndefined()
    const f = c.snapshot().failure
    expect(f?.kind === 'nack' && f.reasonName).toBe('NO_SESSION')

    // Samples for the axis the device really is streaming still land.
    c.ingest(samples(0, [40000]))
    expect(c.snapshot().live?.raw).toBe(40000)

    // And retrying the same axis is possible, because we never claimed to be on it.
    d.api.calStreamSelect = async () => ok(null)
    await c.selectAxis(1)
    expect(c.snapshot().axis).toBe(1)
  })

  it('reports streaming only once a sample for the new axis arrives', async () => {
    // The ACK proves the device accepted the selection; a sample proves data is flowing. Kept
    // separate because the node emits only on change, so a steady axis may send nothing at all.
    const d = fakeDevice()
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    await c.selectAxis(1)
    expect(c.snapshot().streaming, 'accepted, but nothing has arrived yet').toBe(false)

    // A sample for the axis we just left proves nothing about the new one.
    c.ingest(samples(0, [40000]))
    expect(c.snapshot().streaming, 'a stale frame must not count as confirmation').toBe(false)

    c.ingest(samples(1, [30000]))
    expect(c.snapshot().streaming).toBe(true)
  })

  it('restores the measured centre when the rest position is toggled back', async () => {
    // Switching to "no rest position" replaces centre with the midpoint, because that is what
    // gets written. If it overwrote the measurement, switching back would hand the user a
    // midpoint that looks exactly as plausible as the rest position three sweeps had measured —
    // silently, and with no way to tell the difference.
    const d = fakeDevice()
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    c.startCapture()
    // An off-centre rest position on purpose: a rig that rests exactly at the midpoint would
    // make this test pass no matter what the toggle did.
    for (let i = 0; i < 3; i++) await sweep(c, 13000, 51000, 29000)
    const measured = c.snapshot().drafts[0]!.centre
    expect(measured, 'a measured rest position is not the midpoint').not.toBe(
      midpoint(13000, 51000)
    )

    c.setSelfCentring(false)
    expect(c.snapshot().drafts[0]!.centre).toBe(midpoint(13000, 51000))

    c.setSelfCentring(true)
    expect(c.snapshot().drafts[0]!.centre, 'the capture is intact').toBe(measured)
  })

  it('keeps drafts when switching axes', async () => {
    const d = fakeDevice()
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    c.startCapture()
    for (let i = 0; i < 3; i++) await sweep(c, 13000, 51000, 32000)

    await c.selectAxis(1)
    expect(c.snapshot().axis).toBe(1)
    expect(c.snapshot().drafts[0], 'edits persist along the rail').toBeDefined()
    expect(d.calls).toContain('select:1')
  })
})

describe('CalibrationController writing', () => {
  beforeEach(() => {
    clock = 0
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  /** Seed drafts without driving a capture, so write tests stay about writing. */
  function withDrafts(c: CalibrationController, drafts: Record<number, number[]>) {
    for (const [idx, [min, centre, max]] of Object.entries(drafts)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(c as any).state.drafts[Number(idx)] = { min, centre, max, selfCentring: true }
    }
  }

  it('commits one axis at a time and verifies each by reading back', async () => {
    const d = fakeDevice()
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    withDrafts(c, { 0: [13000, 32000, 51000], 1: [14000, 33000, 52000] })

    await c.save()

    // COMMIT then read-back, per axis, in order. An ACK only means "received".
    expect(d.calls.filter((x) => x.startsWith('commit') || x === 'read')).toEqual([
      'commit:0',
      'read',
      'commit:1',
      'read'
    ])
    expect(c.dirtyAxes(), 'drafts clear only once the device confirms').toEqual([])

    // The work is finished, but the result is held on screen: a whole save is two round trips
    // and lands in a few hundred milliseconds, so clearing it immediately leaves a flicker that
    // reads as nothing having happened.
    expect(c.snapshot().write).toMatchObject({ phase: 'done', stored: [0, 1] })
    await vi.advanceTimersByTimeAsync(3000)
    expect(c.snapshot().write).toBeUndefined()
    expect(c.snapshot().notice).toEqual({ kind: 'written', axes: [0, 1] })
  })

  it('confirms a delete, which is otherwise invisible', async () => {
    // The dialog shows nothing after an erase — same numbers, one badge changed on another
    // screen. Without a word the user cannot tell a successful delete from a no-op.
    const d = fakeDevice()
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    withDrafts(c, { 0: [13000, 32000, 51000] })
    await c.save()
    await vi.advanceTimersByTimeAsync(3000)

    await c.deleteAxis(0)
    expect(c.snapshot().notice).toEqual({ kind: 'erased', axes: [0] })
    expect(c.snapshot().device?.axes[0]?.calibrated, 'and the read-back agrees').toBe(false)
  })

  it('drives state from the read-back, not from what was sent', async () => {
    const d = fakeDevice()
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    withDrafts(c, { 0: [13000, 32000, 51000] })
    await c.save()
    expect(c.snapshot().device?.axes[0]).toMatchObject({
      min: 13000,
      centre: 32000,
      max: 51000,
      calibrated: true
    })
  })

  it('fails when the device acknowledges but reads back something else', async () => {
    // An ACK is "received", never "stored". Without this check a mishandled write would leave a
    // green badge on an axis the device knows nothing about.
    const d = fakeDevice()
    d.api.calCommit = async () => ok(null) // acknowledges, stores nothing
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    withDrafts(c, { 0: [13000, 32000, 51000] })
    await c.save()
    expect(c.snapshot().failure?.message).toMatch(/read back different values/)
    expect(c.dirtyAxes(), 'dirty state survives so the user can retry').toEqual([0])
  })

  it('keeps dirty state on a nack and names the axis', async () => {
    const d = fakeDevice()
    d.fail.commit = {
      ok: false,
      kind: 'nack',
      reason: 0x05,
      reasonName: 'BAD_ORDER',
      detail: 1,
      message: 'endpoints out of order'
    }
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    withDrafts(c, { 1: [50000, 100, 200] })
    await c.save()
    expect(c.snapshot().failure).toMatchObject({ kind: 'nack', reasonName: 'BAD_ORDER', axis: 1 })
    expect(c.dirtyAxes()).toEqual([1])
  })

  it('re-reads on a timeout instead of claiming nothing was written', async () => {
    // A timeout cannot separate "never received" from "wrote it and the reply was lost", so the
    // only honest answer is what the device reports afterwards.
    const d = fakeDevice()
    let commits = 0
    d.api.calCommit = async (a) => {
      commits++
      d.stored[a.idx] = { min: a.min, centre: a.centre, max: a.max } // it DID land
      return { ok: false, kind: 'timeout', message: 'no reply within 2000 ms' }
    }
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    withDrafts(c, { 0: [13000, 32000, 51000] })
    await c.save()

    expect(commits).toBe(1)
    expect(c.snapshot().failure?.kind).toBe('timeout')
    expect(
      c.snapshot().device?.axes[0]?.calibrated,
      'the re-read must reveal the write that did land'
    ).toBe(true)
    // And having proved it landed, the draft must not sit dirty inviting a redundant rewrite.
    expect(c.dirtyAxes(), 'a confirmed write is no longer pending').toEqual([])
    expect(c.snapshot().storedBeforeFailure, 'it stored, so say so').toEqual([0])
  })

  it('does not mistake a pre-existing calibration for the write landing', async () => {
    // The dangerous shape: the axis was already calibrated, the user edits it, and the commit
    // times out without landing. The device still reports `calibrated` — with the OLD values.
    // Reconciling on that flag alone would clear the draft and discard the user's edit while the
    // device holds something else entirely.
    const d = fakeDevice()
    d.stored[0] = { min: 20000, centre: 32000, max: 45000 } // an older calibration
    d.api.calCommit = async () => ({ ok: false, kind: 'timeout', message: 'no reply' })
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    withDrafts(c, { 0: [13000, 32000, 51000] }) // wider, and different

    await c.save()

    expect(c.snapshot().device?.axes[0]?.calibrated, 'the old calibration is still there').toBe(
      true
    )
    expect(c.dirtyAxes(), 'the edit did not land, so it stays pending').toEqual([0])
    expect(c.snapshot().storedBeforeFailure).toEqual([])
  })

  it('keeps the draft when a timed-out commit did NOT land', async () => {
    const d = fakeDevice()
    d.api.calCommit = async () => ({ ok: false, kind: 'timeout', message: 'no reply' })
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    withDrafts(c, { 0: [13000, 32000, 51000] })
    await c.save()
    expect(c.dirtyAxes(), 'nothing was stored, so the edit is still pending').toEqual([0])
    expect(c.snapshot().storedBeforeFailure).toEqual([])
  })

  it('names the axes that did store before a failure stopped the queue', async () => {
    const d = fakeDevice()
    const real = d.api.calCommit
    d.api.calCommit = async (a) =>
      a.idx === 1 ? { ok: false, kind: 'timeout', message: 'no reply' } : real(a)
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    withDrafts(c, { 0: [13000, 32000, 51000], 1: [14000, 33000, 52000] })
    await c.save()

    expect(c.snapshot().storedBeforeFailure, 'partial success is worth naming').toEqual([0])
    expect(c.dirtyAxes(), 'only the unwritten axis stays dirty').toEqual([1])
  })

  it('blocks a write that the device would refuse, naming which axis', () => {
    const d = fakeDevice()
    const c = new CalibrationController(d.api, now)
    withDrafts(c, { 0: [13000, 32000, 51000], 2: [40000, 100, 200] })
    expect(c.invalidAxis()).toEqual({ axis: 2, reason: 'centre must fall between min and max' })
  })

  it('lets the rest position be chosen before any capture', async () => {
    // The choice decides whether the capture has a centre step at all, so it has to be reachable
    // first. Tying it to a draft meant the first capture on every axis ran the centre step
    // regardless, and the setting only became available once it was too late to matter.
    const d = fakeDevice()
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    expect(c.selfCentring(), 'defaults to capturing a rest position').toBe(true)

    c.setSelfCentring(false)
    expect(c.selfCentring()).toBe(false)

    c.startCapture()
    expect(c.snapshot().capture?.selfCentring, 'the capture honours the choice').toBe(false)
  })

  it('a non-centring capture never asks for a release, and derives the midpoint', async () => {
    const d = fakeDevice()
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    c.setSelfCentring(false)
    c.startCapture()
    for (let i = 0; i < 3; i++) await sweep(c, 13000, 51000) // no centre passed
    expect(c.snapshot().drafts[0]).toMatchObject({
      min: 13000,
      max: 51000,
      centre: 32000, // midpoint of the captured travel
      selfCentring: false
    })
  })

  it('remembers the choice per axis', async () => {
    const d = fakeDevice()
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    c.setSelfCentring(false)
    await c.selectAxis(1)
    expect(c.selfCentring(), 'axis 1 keeps the default').toBe(true)
    expect(c.selfCentring(0), 'axis 0 keeps its own choice').toBe(false)
  })

  it('re-derives centre when an axis is marked non-centring', async () => {
    const d = fakeDevice()
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    withDrafts(c, { 0: [13000, 20000, 51000] })
    c.setSelfCentring(false)
    expect(c.snapshot().drafts[0]!.centre, 'midpoint of 13000..51000').toBe(32000)
  })
})

describe('CalibrationController delete', () => {
  beforeEach(() => {
    clock = 0
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('deletes and confirms by reading back', async () => {
    const d = fakeDevice()
    d.stored[0] = { min: 13000, centre: 32000, max: 51000 }
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    await c.deleteAxis(0)
    expect(c.snapshot().device?.axes[0]?.calibrated).toBe(false)
  })

  it('does not treat a delete as done when the device cannot be re-read', async () => {
    // The ACK says "received". Only a read showing the axis uncalibrated says "erased" — the
    // same rule the write path follows.
    const d = fakeDevice()
    d.stored[0] = { min: 13000, centre: 32000, max: 51000 }
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    d.fail.read = { ok: false, kind: 'timeout', message: 'no reply' }
    await c.deleteAxis(0)
    expect(c.snapshot().failure?.kind, 'an unverified delete is a failure').toBe('timeout')
  })

  it('does not treat a delete as done when the axis comes back still calibrated', async () => {
    const d = fakeDevice()
    d.stored[0] = { min: 13000, centre: 32000, max: 51000 }
    d.api.calReset = async () => ok(null) // acknowledges, erases nothing
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    await c.deleteAxis(0)
    expect(c.snapshot().failure?.message).toMatch(/still reports this axis as calibrated/)
    expect(c.snapshot().device?.axes[0]?.calibrated).toBe(true)
  })

  it('surfaces a delete failure — RESET is the same flash write as COMMIT', async () => {
    // The mock has no failure path for delete. RESET persists through the same sector erase, so
    // it returns NO_STORAGE or times out exactly as a commit does.
    const d = fakeDevice()
    d.stored[0] = { min: 13000, centre: 32000, max: 51000 }
    d.fail.reset = {
      ok: false,
      kind: 'nack',
      reason: 0x07,
      reasonName: 'NO_STORAGE',
      detail: 0xff,
      message: 'the flash write failed'
    }
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    await c.deleteAxis(0)
    expect(c.snapshot().failure).toMatchObject({ reasonName: 'NO_STORAGE', axis: 0 })
    expect(c.snapshot().device?.axes[0]?.calibrated, 'and the axis is still calibrated').toBe(true)
  })
})

describe('CalibrationController device identity', () => {
  it('drops drafts when a different board appears', () => {
    // Endpoints are per-unit. Carrying one board's captures onto another would produce a
    // plausible-looking but wrong calibration, which fails open rather than closed.
    const d = fakeDevice()
    const c = new CalibrationController(d.api, now)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).state.drafts[0] = { min: 1, centre: 2, max: 3, selfCentring: true }
    c.deviceChanged({ ...snapshot({}), serialNumber: 'BOARD-B' })
    expect(c.dirtyAxes()).toEqual([])
  })

  it('keeps drafts when the same board reports again', () => {
    const d = fakeDevice()
    const c = new CalibrationController(d.api, now)
    c.deviceChanged(snapshot({}))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).state.drafts[0] = { min: 1, centre: 2, max: 3, selfCentring: true }
    c.deviceChanged(snapshot({ 1: { min: 1, centre: 2, max: 3 } }))
    expect(c.dirtyAxes()).toEqual([0])
  })
})
