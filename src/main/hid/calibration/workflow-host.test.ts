import { afterEach, describe, expect, it, vi } from 'vitest'
import { CALIBRATION_IDLE, type CalibrationState, type CalSnapshot } from '@shared/hid/calibration'
import type { CalibrationCommands } from './calibration-workflow'
import { tabState } from './calibration-view-model'
import { CalibrationWorkflowHost } from './workflow-host'

const snapshot = (calibratedMask: number, serial = 'BOARD-A'): CalSnapshot => ({
  presentMask: 0b11,
  calibratedMask,
  axes: Array.from({ length: 8 }, (_, idx) => ({
    idx,
    controlId: idx < 2 ? 0x10 + idx : 0,
    min: 0,
    centre: 0,
    max: 0,
    deadzone: 0,
    present: idx < 2,
    calibrated: (calibratedMask & (1 << idx)) !== 0
  })),
  serialNumber: serial
})

const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value })

/** A Gateway that answers everything and a cache that holds nothing. */
const commands: CalibrationCommands = {
  calRead: () => ok(snapshot(0)),
  calSessionOpen: (axisIdx) => ok({ timeoutMs: 30_000, axisIdx }),
  calStreamSelect: () => ok(null),
  calCommit: () => ok(null),
  calReset: () => ok(null),
  calSessionClose: () => ok(null),
  calCacheRead: () => ok({ regressed: [] }),
  calCacheStore: () => ok(null),
  calCacheDrop: () => ok(null)
}

function host() {
  const pushed: CalibrationState[] = []
  const h = new CalibrationWorkflowHost(commands, (s) => pushed.push(s))
  return { h, pushed, snap: () => h.state().tab.snapshot }
}

describe('CalibrationWorkflowHost', () => {
  it('starts in the state the renderer starts from', () => {
    const { h, pushed } = host()
    expect(h.state()).toEqual(CALIBRATION_IDLE)
    expect(pushed, 'nothing is pushed before anything happens').toEqual([])
  })
})

// The workflow's lifetime is the HID tab's mount (`cal:attach`), as useCalibration's controller's
// was: a remount, or a renderer reload, starts from a fresh one.
describe('the HID-tab view (cal:attach)', () => {
  afterEach(() => vi.useRealTimers())

  const sample = (raw: number) => [{ t: Date.now(), idx: 1, raw, cal: raw }]

  async function opened() {
    const spied = { ...commands, calRead: vi.fn(commands.calRead) }
    const pushed: CalibrationState[] = []
    const h = new CalibrationWorkflowHost(spied, (s) => pushed.push(s))
    h.linkStatus('connected')
    h.reported(snapshot(0b01))
    h.attach(true)
    await h.open(1)
    return { h, spied, pushed }
  }

  it('has nothing to act on, and drops RAW, until the tab mounts', async () => {
    const { h } = host()
    await h.open(1)
    h.ingest(sample(40_000))
    expect(h.state().dialog).toBeUndefined()
  })

  it('a remount starts a fresh workflow: nothing from the last view comes back', async () => {
    const { h } = await opened()
    h.ingest(sample(40_000))
    expect(h.state().dialog?.workflow.live?.raw).toBe(40_000)
    h.attach(false)
    expect(h.state().dialog, 'unmounted: no dialog').toBeUndefined()
    h.ingest(sample(41_000))
    h.attach(true)
    await h.open(1)
    expect(h.state().dialog?.workflow.live, 'the earlier reading is gone').toBeUndefined()
  })

  it('an unmount disposes the workflow: its ticker and timers stop', async () => {
    vi.useFakeTimers()
    const { h } = await opened()
    h.startCapture()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    h.attach(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a reload (a mount with the old view never unmounted) leaves the old view behind', async () => {
    const { h } = await opened()
    expect(h.state().dialog).toBeDefined()
    h.attach(true)
    expect(h.state().dialog).toBeUndefined()
  })

  it('a renderer load drops the old view; what it started never reaches the device again', async () => {
    const { h, spied } = await opened()
    const closing = h.close()
    h.rendererLoaded()
    expect(h.state().dialog).toBeUndefined()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(spied.calRead, 'the dead page never asked for its re-read').not.toHaveBeenCalled()
    void closing
  })
})

// The store's calibration lifecycle before R3.1 (the renderer's store tests): the device's report
// is held while the link is up and dropped whenever it is not. The rule moved here with the workflow.
describe('calibration state lifecycle', () => {
  it('starts with no snapshot, which is not the same as uncalibrated', () => {
    const { snap } = host()
    expect(snap()).toBeUndefined()
  })

  it('takes the snapshot from the device report', () => {
    const { h, snap } = host()
    h.reported(snapshot(0b01))
    expect(snap()?.calibratedMask).toBe(0b01)
  })

  // Clearing only on `no-device` would leave the previous board's badges on screen through a
  // reconnect -- and permanently, if the next board runs firmware that never answers GET_CAL.
  for (const state of ['reconnecting', 'error', 'no-device', 'scanning', 'disconnected'] as const) {
    it(`drops the snapshot when the device goes ${state}`, () => {
      const { h, snap } = host()
      h.reported(snapshot(0b01))
      expect(snap()).toBeDefined()
      h.linkStatus(state)
      expect(snap(), `${state} means the snapshot cannot be vouched for`).toBeUndefined()
    })
  }

  it('keeps the snapshot while the link stays up', () => {
    const { h, snap } = host()
    h.reported(snapshot(0b01))
    h.linkStatus('connected')
    expect(snap()?.calibratedMask).toBe(0b01)
  })

  it('replaces one board’s snapshot with the next board’s, never merging them', () => {
    const { h, snap } = host()
    h.reported(snapshot(0b11, 'BOARD-A'))
    h.linkStatus('reconnecting')
    expect(snap()).toBeUndefined()
    h.linkStatus('connected')
    h.reported(snapshot(0b00, 'BOARD-B'))
    expect(snap()?.serialNumber).toBe('BOARD-B')
    expect(snap()?.calibratedMask).toBe(0b00)
  })
})

// N6: the per-axis badge opened the dialog with the link down while Calibrate was greyed out.
describe('the badges follow the Calibrate button’s link rule (N6)', () => {
  it('with the link down a badge shows its state but does not open the dialog', () => {
    const tab = tabState(snapshot(0b01), false, undefined)
    expect(tab.badges).toEqual({ 0: 'cal', 1: 'raw' })
    expect(tab.calibrate.enabled).toBe(false)
    expect(tab.badgeOpens, 'the same rule as Calibrate').toBe(false)
  })

  it('with the link up both open it', () => {
    const tab = tabState(snapshot(0b01), true, undefined)
    expect(tab.calibrate.enabled).toBe(true)
    expect(tab.badgeOpens).toBe(true)
  })

  it('the host pushes it with the link: a report that lands after a drop opens nothing', () => {
    const { h } = host()
    h.linkStatus('connected')
    h.reported(snapshot(0b01))
    expect(h.state().tab).toMatchObject({ badgeOpens: true, calibrate: { enabled: true } })
    h.linkStatus('reconnecting')
    h.reported(snapshot(0b01))
    expect(h.state().tab).toMatchObject({
      badges: { 0: 'cal', 1: 'raw' },
      badgeOpens: false,
      calibrate: { enabled: false }
    })
  })
})
