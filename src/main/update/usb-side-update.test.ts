// #173: the Gateway USB side's update, step by step, with every port faked: each failure, where its
// Retry starts, and what happens to the calibration.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogEventInput } from '@shared/events'
import type { CalSnapshot } from '@shared/hid/calibration'
import { UsbSideUpdate, type RunResult, type UsbSidePorts } from './usb-side-update'

const DRIVE = '/Volumes/RPI-RP2'

const snap = (calibrated: boolean[]): CalSnapshot => ({
  presentMask: 0b11,
  calibratedMask: 0,
  axes: calibrated.map((c, idx) => ({
    idx,
    controlId: 0x30 + idx,
    min: 0,
    centre: 1,
    max: 2,
    deadzone: 0,
    present: true,
    calibrated: c
  })),
  serialNumber: 'S'
})

/** The ports, scripted: `board` says what the Gateway does at each moment. */
function harness(
  board: {
    port?: string | undefined
    driveOnTouch?: boolean
    copyOk?: boolean
    /** The version HELLO reports after the copy; undefined = no answer; 'never' = it never comes. */
    comesBackOn?: string | 'never'
    /** After it comes back, still in its drive (the copy didn't take). */
    stuckInDrive?: boolean
    before?: CalSnapshot
    after?: CalSnapshot
    copy?: number[]
    regressed?: number[]
    restoreOk?: boolean
    image?: false
  } = {}
) {
  let mounted: string | undefined
  let snapshot = board.before
  const events: LogEventInput[] = []
  const calls: string[] = []
  const ref: { flow?: UsbSideUpdate } = {}
  const ports: UsbSidePorts = {
    link: {
      take: () => {
        calls.push('take')
        snapshot = undefined // releasing the port clears what calibration read
        return Promise.resolve('port' in board ? board.port : '/dev/gw')
      },
      touch: (path) => {
        calls.push(`touch ${path}`)
        if (board.driveOnTouch !== false) mounted = DRIVE
        return Promise.resolve()
      },
      handBack: () => {
        calls.push('handBack')
        if (board.comesBackOn === 'never') return
        setTimeout(() => {
          if (!board.stuckInDrive) mounted = undefined
          if (board.comesBackOn === undefined && 'comesBackOn' in board)
            return ref.flow!.helloAnswered(undefined)
          const [major, minor, patch] = (board.comesBackOn ?? '1.0.1').split('.').map(Number)
          ref.flow!.helloAnswered({ major: major!, minor: minor!, patch: patch! })
          setTimeout(() => (snapshot = board.after), 300)
        }, 2_000)
      }
    },
    drive: {
      find: () => Promise.resolve(mounted),
      write: (root, name, _bytes, pct) => {
        calls.push(`write ${root} ${name}`)
        pct(50)
        if (board.copyOk === false) {
          mounted = undefined
          return Promise.resolve(false)
        }
        pct(100)
        if (!board.stuckInDrive) mounted = undefined
        return Promise.resolve(true)
      }
    },
    image: (version) =>
      Promise.resolve(
        board.image === false
          ? {
              ok: false as const,
              message: `The saved copy of firmware ${version} is damaged and couldn’t be downloaded again.`
            }
          : { ok: true as const, bytes: new Uint8Array(10), name: `gateway-${version}.uf2` }
      ),
    calibration: {
      snapshot: () => snapshot,
      regressed: () => board.regressed ?? [],
      hasCopy: (axes) => axes.every((a) => (board.copy ?? []).includes(a)),
      restore: (axes) => {
        calls.push(`restore ${axes.join(',')}`)
        return Promise.resolve(board.restoreOk !== false)
      }
    },
    events: (rows) => events.push(...rows),
    now: () => Date.now()
  }
  const flow = (ref.flow = new UsbSideUpdate('1.0.1', ports))
  const steps: number[] = []
  const pcts: number[] = []
  const run = async (from = 0): Promise<RunResult> => {
    const p = flow.run(from, { step: (n) => steps.push(n), pct: (n) => pcts.push(n) })
    await vi.advanceTimersByTimeAsync(60_000)
    return p
  }
  return {
    run,
    calls,
    events,
    steps,
    pcts,
    mount: () => (mounted = DRIVE),
    setBoard: (patch: typeof board) => Object.assign(board, patch)
  }
}

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

describe('UsbSideUpdate (#173)', () => {
  it('runs every step: take, touch, copy the release’s .uf2, hand back, confirm the version', async () => {
    const h = harness()
    expect(await h.run()).toEqual({ ok: true, reports: '1.0.1' })
    expect(h.calls).toEqual([
      'take',
      'touch /dev/gw',
      `write ${DRIVE} gateway-1.0.1.uf2`,
      'handBack'
    ])
    expect(h.steps).toEqual([0, 1, 2, 3])
    expect(h.pcts).toEqual([50, 100])
  })

  it('a drive already mounted (a blank Gateway, BOOTSEL held) starts at the copy: no touch', async () => {
    const h = harness()
    h.mount()
    expect((await h.run()).ok).toBe(true)
    expect(h.calls).not.toContain('take')
  })

  it('no drive after the touch → no-drive, Retry from the touch; nothing was written', async () => {
    const h = harness({ driveOnTouch: false })
    expect(await h.run()).toEqual({ ok: false, failure: { kind: 'no-drive' }, at: 0, retryFrom: 0 })
    expect(h.calls.some((c) => c.startsWith('write'))).toBe(false)
    // No Gateway port at all (unplugged, or already in its bootloader): no touch, same failure.
    const none = harness({ port: undefined, driveOnTouch: false })
    expect((await none.run()).ok).toBe(false)
    expect(none.calls).toEqual(['take'])
    // Plugged in holding BOOTSEL, then Retry: copies and finishes.
    h.mount()
    expect(await h.run(0)).toEqual({ ok: true, reports: '1.0.1' })
  })

  it('the copy fails → copy-failed, Retry copies the whole file again', async () => {
    const h = harness({ copyOk: false })
    expect(await h.run()).toEqual({
      ok: false,
      failure: { kind: 'copy-failed' },
      at: 1,
      retryFrom: 1
    })
    h.setBoard({ copyOk: true })
    h.mount() // back in its drive (BOOTSEL)
    expect((await h.run(1)).ok).toBe(true)
  })

  it('no reconnect → no-reconnect, Retry looks again; still in its drive → Retry copies again', async () => {
    const gone = harness({ comesBackOn: 'never' })
    expect(await gone.run()).toEqual({
      ok: false,
      failure: { kind: 'no-reconnect' },
      at: 2,
      retryFrom: 2
    })
    const stuck = harness({ comesBackOn: 'never', stuckInDrive: true })
    expect(await stuck.run()).toEqual({
      ok: false,
      failure: { kind: 'no-reconnect' },
      at: 2,
      retryFrom: 1
    })
  })

  it('HELLO unanswered after the copy reads as no reconnect, not a wrong version', async () => {
    const h = harness({ comesBackOn: undefined })
    expect(await h.run()).toMatchObject({ ok: false, failure: { kind: 'no-reconnect' } })
  })

  it('the wrong version → wrong-version with what it reports; Retry starts over', async () => {
    const h = harness({ comesBackOn: '1.0.0' })
    expect(await h.run()).toEqual({
      ok: false,
      failure: { kind: 'wrong-version', reported: '1.0.0' },
      at: 3,
      retryFrom: 0
    })
  })

  it('the image can’t be read → image, with the release cache’s own words', async () => {
    const h = harness({ image: false })
    expect(await h.run()).toEqual({
      ok: false,
      failure: {
        kind: 'image',
        message: 'The saved copy of firmware 1.0.1 is damaged and couldn’t be downloaded again.'
      },
      at: 0,
      retryFrom: 0
    })
    expect(h.calls).toEqual([])
  })
})

describe('UsbSideUpdate calibration (#173)', () => {
  it('cleared, with a saved copy → restored, one info row', async () => {
    const h = harness({ before: snap([true, false]), after: snap([false, false]), copy: [0] })
    expect(await h.run()).toEqual({ ok: true, reports: '1.0.1', calibration: 'restored' })
    expect(h.calls).toContain('restore 0')
    expect(h.events).toEqual([
      expect.objectContaining({
        name: 'Gateway',
        severity: 'info',
        event: 'calibration restored',
        detail: "1 axis, from this computer's copy, after the firmware update"
      })
    ])
  })

  it('cleared, no saved copy → the note, nothing written, no row', async () => {
    const h = harness({ before: snap([true]), after: snap([false]), copy: [] })
    expect((await h.run()) as { calibration?: string }).toMatchObject({
      calibration: 'cleared-no-copy'
    })
    expect(h.calls.some((c) => c.startsWith('restore'))).toBe(false)
    expect(h.events).toEqual([])
  })

  it('writing the copy back fails → restore-failed, an error row', async () => {
    const h = harness({ before: snap([true]), after: snap([false]), copy: [0], restoreOk: false })
    expect(await h.run()).toMatchObject({ calibration: 'restore-failed' })
    expect(h.events).toEqual([
      expect.objectContaining({ severity: 'error', event: 'calibration not restored' })
    ])
  })

  it('kept, or never calibrated before → nothing to restore, no note', async () => {
    expect(await harness({ before: snap([true]), after: snap([true]), copy: [0] }).run()).toEqual({
      ok: true,
      reports: '1.0.1'
    })
    expect(await harness({ before: snap([false]), after: snap([false]), copy: [0] }).run()).toEqual(
      {
        ok: true,
        reports: '1.0.1'
      }
    )
  })

  it('no before-reading → the owner’s own check (regressedAxes) decides', async () => {
    const h = harness({ after: snap([false]), copy: [0], regressed: [0] })
    expect(await h.run()).toMatchObject({ calibration: 'restored' })
    const none = harness({ after: snap([false]), copy: [0], regressed: [] })
    expect((await none.run()) as { calibration?: string }).not.toHaveProperty('calibration')
  })
})
