import { describe, expect, it } from 'vitest'
import { CALIBRATION_IDLE, type CalibrationState, type CalSnapshot } from '@shared/hid/calibration'
import type { CalibrationCommands } from './calibration-workflow'
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

// The store's calibration lifecycle before R3.1 (renderer store.test.ts): the device's report is
// held while the link is up and dropped whenever it is not. The rule moved here with the workflow.
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
  // reconnect -- and permanently, if the next board runs firmware that never sends cal:data.
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
