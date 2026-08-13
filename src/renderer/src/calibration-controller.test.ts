import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CAPTURE_CONFIG } from '@shared/axis-capture'
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

/** Drive a full sweep on the controller the way a user's movements would. */
async function sweep(c: CalibrationController, lo: number, hi: number, centre?: number) {
  const hold = (v: number) => {
    c.ingest(samples(0, [v, v + 150])) // the value, then the noise that confirms it
    clock += C.endpointHoldMs + 200
    vi.advanceTimersByTime(C.endpointHoldMs + 200)
  }
  hold(hi)
  hold(lo)
  if (centre !== undefined) {
    c.ingest(samples(0, [centre, centre + 120]))
    clock += C.centreStableMs + 200
    vi.advanceTimersByTime(C.centreStableMs + 200)
  }
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
    c.startCapture(true)
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

  it('keeps drafts when switching axes', async () => {
    const d = fakeDevice()
    const c = new CalibrationController(d.api, now)
    await c.open(0)
    c.startCapture(true)
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
    expect(c.snapshot().write).toBeUndefined()
    expect(c.dirtyAxes(), 'drafts clear only once the device confirms').toEqual([])
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
