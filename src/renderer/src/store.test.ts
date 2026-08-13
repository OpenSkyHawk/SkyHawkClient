import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalSnapshot, PushChannel, PushChannels, RelayStatus } from '@shared/ipc'

// The store talks to main through window.skyhawk. Only the calls initBridge() makes need to be
// real here; the rest exist so subscription setup does not throw.
type Listener = (data: unknown) => void
const listeners = new Map<string, Listener[]>()
let status: RelayStatus = { running: false, device: { state: 'no-device' } }

function fakeApi() {
  return {
    on: (ch: PushChannel, cb: Listener) => {
      listeners.set(ch, [...(listeners.get(ch) ?? []), cb])
      return () => {}
    },
    getStatus: () => Promise.resolve(status),
    getConfig: () =>
      Promise.resolve({
        sourceMode: 'bridge',
        transport: 'tcp-to-host',
        host: '127.0.0.1',
        commandPort: 7778,
        listenPort: 5010,
        autoReconnect: true,
        replayDriveSerial: false,
        debugMode: false
      }),
    getHidAvailability: () => Promise.resolve({ axes: [0, 1], hats: [], buttons: [] })
  }
}

/** Deliver a main -> renderer push, as the preload bridge would. */
function push<C extends PushChannel>(ch: C, data: PushChannels[C]) {
  for (const cb of listeners.get(ch) ?? []) cb(data)
}

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

/**
 * A fresh module instance per test.
 *
 * store.ts guards against duplicate IPC subscriptions with a module-level flag, so reusing the
 * import would make initBridge() a no-op after the first test — and a reload is exactly what is
 * under test here.
 */
async function freshStore() {
  listeners.clear()
  vi.resetModules()
  ;(globalThis as { window?: unknown }).window = { skyhawk: fakeApi() }
  const mod = await import('./store')
  const { useStore } = mod
  await useStore.getState().initBridge()
  await Promise.resolve()
  await Promise.resolve()
  return useStore
}

describe('calibration state lifecycle', () => {
  beforeEach(() => {
    status = { running: false, device: { state: 'no-device' } }
  })

  it('starts with no snapshot, which is not the same as uncalibrated', async () => {
    const s = await freshStore()
    expect(s.getState().cal).toBeUndefined()
  })

  it('takes the snapshot from a cal:data push', async () => {
    const s = await freshStore()
    push('cal:data', snapshot(0b01))
    expect(s.getState().cal?.calibratedMask).toBe(0b01)
  })

  it('rehydrates the snapshot on a renderer reload', async () => {
    // The regression: a reload builds a fresh store while the main-process session keeps
    // running. No port-open event follows, so no cal:data is pushed, and without the snapshot
    // in session status the badges would stay blank indefinitely on a stable link.
    status = {
      running: true,
      device: { state: 'relaying', portPath: '/dev/fake' },
      cal: snapshot(0b01)
    }
    const s = await freshStore()
    expect(s.getState().cal?.calibratedMask, 'reload must recover the badges').toBe(0b01)
    expect(s.getState().deviceState).toBe('relaying')
  })

  it('rehydrates nothing when the link is down', async () => {
    status = { running: false, device: { state: 'no-device' } }
    const s = await freshStore()
    expect(s.getState().cal).toBeUndefined()
  })

  // Clearing only on `no-device` would leave the previous board's badges on screen through a
  // reconnect -- and permanently, if the next board runs firmware that never sends cal:data.
  for (const state of ['reconnecting', 'error', 'no-device', 'scanning'] as const) {
    it(`drops the snapshot when the device goes ${state}`, async () => {
      const s = await freshStore()
      push('cal:data', snapshot(0b01))
      expect(s.getState().cal).toBeDefined()
      push('device:status', { state })
      expect(s.getState().cal, `${state} means the snapshot cannot be vouched for`).toBeUndefined()
    })
  }

  it('keeps the snapshot while the link stays up', async () => {
    const s = await freshStore()
    push('cal:data', snapshot(0b01))
    push('device:status', { state: 'relaying', portPath: '/dev/fake' })
    expect(s.getState().cal?.calibratedMask).toBe(0b01)
  })

  it('replaces one board’s snapshot with the next board’s, never merging them', async () => {
    const s = await freshStore()
    push('cal:data', snapshot(0b11, 'BOARD-A'))
    push('device:status', { state: 'reconnecting' })
    expect(s.getState().cal).toBeUndefined()
    push('device:status', { state: 'relaying' })
    push('cal:data', snapshot(0b00, 'BOARD-B'))
    expect(s.getState().cal?.serialNumber).toBe('BOARD-B')
    expect(s.getState().cal?.calibratedMask).toBe(0b00)
  })
})
