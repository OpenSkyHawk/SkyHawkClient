// #173: the update dialog's state as the host runs it: the checks, *I understand*, one update at a
// time, no Close while it runs, Retry from where the failure says.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReleaseTarget } from '@shared/releases'
import type { UpdateState } from '@shared/update'
import { UpdateHost } from './update-host'
import type { UsbSidePorts } from './usb-side-update'

const release = (version = '1.0.1', usb = true): ReleaseTarget => ({
  version,
  compare: () => 0,
  hasImage: () => usb
})

function host(
  opts: {
    relay?: boolean
    link?: boolean
    cockpit?: number
    release?: ReleaseTarget
    drive?: boolean
  } = {}
) {
  const pushes: (UpdateState | null)[] = []
  const inputs = { relay: opts.relay ?? false, link: opts.link ?? true }
  let mounted: string | undefined
  const ref: { h?: UpdateHost } = {}
  const usb: UsbSidePorts = {
    link: {
      take: () => Promise.resolve('/dev/gw'),
      touch: () => {
        if (opts.drive !== false) mounted = '/Volumes/RPI-RP2'
        return Promise.resolve()
      },
      handBack: () => setTimeout(() => ref.h!.usbFirmware({ major: 1, minor: 0, patch: 1 }), 1_000)
    },
    drive: {
      find: () => Promise.resolve(mounted),
      write: (_r, _n, _b, pct) => {
        pct(100)
        mounted = undefined
        return Promise.resolve(true)
      }
    },
    image: () =>
      Promise.resolve({ ok: true as const, bytes: new Uint8Array(1), name: 'gateway-1.0.1.uf2' }),
    calibration: {
      snapshot: () => undefined,
      regressed: () => [],
      hasCopy: () => false,
      restore: () => Promise.resolve(true)
    },
    events: () => {},
    now: () => Date.now(),
    timing: { calMs: 0 }
  }
  const h = (ref.h = new UpdateHost((_c, p) => void pushes.push(p), {
    relayRunning: () => inputs.relay,
    linkUp: () => inputs.link,
    cockpitMajor: () => opts.cockpit,
    release: () => ('release' in opts ? opts.release : release()),
    usb
  }))
  return { h, pushes, inputs, last: () => pushes.at(-1) }
}

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

describe('UpdateHost (#173)', () => {
  it('opens on the confirm step: from the HELLO version to the saved release, every check listed', () => {
    const { h, last } = host()
    h.usbFirmware({ major: 1, minor: 0, patch: 0 })
    h.openUpdate({ kind: 'usb' })
    expect(last()).toEqual({
      target: { kind: 'usb' },
      name: 'Gateway · USB side',
      from: '1.0.0',
      to: '1.0.1',
      phase: 'confirm',
      checks: [
        { kind: 'relay', ok: true },
        { kind: 'link', ok: true },
        { kind: 'image', ok: true, version: '1.0.1' }
      ],
      ack: false,
      canStart: true,
      estimateSec: 5,
      steps: [
        { key: 'uf2', state: 'waiting' },
        { key: 'copy', state: 'waiting' },
        { key: 'rec', state: 'waiting' },
        { key: 'ver', state: 'waiting' }
      ],
      pct: 0,
      relayRunning: false
    })
  })

  it('nothing saved: nothing to open', () => {
    const { h, pushes } = host({ release: undefined })
    h.openUpdate({ kind: 'usb' })
    expect(pushes).toEqual([])
  })

  it('the relay, the link and the image each block the start; a change re-pushes the checks', async () => {
    const { h, inputs, last } = host({ relay: true, link: false, release: release('1.0.1', false) })
    h.openUpdate({ kind: 'usb' })
    expect(last()?.checks.map((c) => c.ok)).toEqual([false, false, false])
    expect(last()?.canStart).toBe(false)
    await h.start()
    expect(last()?.phase).toBe('confirm')
    inputs.relay = false
    h.inputsChanged()
    expect(last()?.checks[0]).toEqual({ kind: 'relay', ok: true })
  })

  it('halves on different majors: the warning, and the start waits for I understand', () => {
    const { h, last } = host({ cockpit: 0 })
    h.openUpdate({ kind: 'usb' })
    expect(last()).toMatchObject({ halves: { usb: 1, cockpit: 0 }, canStart: false })
    h.ack(true)
    expect(last()).toMatchObject({ ack: true, canStart: true })
  })

  it('runs: steps advance, no Close mid-run, one update at a time; then done', async () => {
    const { h, last, pushes } = host()
    h.openUpdate({ kind: 'usb' })
    const run = h.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(last()?.phase).toBe('run')
    h.close()
    h.openUpdate({ kind: 'usb' })
    expect(last()?.phase).toBe('run')
    await vi.advanceTimersByTimeAsync(5_000)
    await run
    expect(pushes.some((p) => p?.steps[1]?.pct === 100)).toBe(true)
    expect(last()).toMatchObject({
      phase: 'done',
      pct: 100,
      done: { reports: '1.0.1' },
      steps: [{ state: 'done' }, { state: 'done' }, { state: 'done' }, { state: 'done' }]
    })
    h.close()
    expect(last()).toBeNull()
  })

  it('a failure marks its step and keeps the dialog; Retry starts where it said', async () => {
    const { h, last } = host({ drive: false })
    h.openUpdate({ kind: 'usb' })
    const run = h.start()
    await vi.advanceTimersByTimeAsync(11_000)
    await run
    expect(last()).toMatchObject({
      phase: 'fail',
      failure: { kind: 'no-drive' },
      steps: [{ state: 'bad' }, { state: 'waiting' }, { state: 'waiting' }, { state: 'waiting' }]
    })
    expect(last()?.done).toBeUndefined()
  })
})
