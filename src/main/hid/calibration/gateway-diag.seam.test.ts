// #169 over the calibration seam: HidCalibrationService asks GET_DIAG after HELLO on connect,
// against a fake Gateway that answers — and one on older firmware that never does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAL_TYPE, buildFrame } from './codec'
import type { CacheFileIO } from './cache-store'

// app/debug-log.ts imports electron for its log path; nothing here needs the real thing.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

const { HidCalibrationService } = await import('./hid-calibration-service')

const HELLO_ACK = Uint8Array.of(1, 1, 8, 0, 2, 0)
const CAL_DATA = new Uint8Array(82)
/** DIAG: up 60 s, one USB loss at 20 s after a UART error at 10 s, one software re-plug. */
const DIAG = (() => {
  const p = new Uint8Array(64)
  const v = new DataView(p.buffer)
  v.setUint32(0, 60_000, true) // UPTIME_MS
  v.setUint32(4, 10_000, true) // FIRST_UART_ERR_MS
  v.setUint32(12, 20_000, true) // FIRST_USB_LOSS_MS
  v.setUint16(40, 1, true) // USB_REATTACHES
  return p
})()

const noCache: CacheFileIO = { read: () => ({ kind: 'missing' }), write: () => undefined }

/**
 * A Gateway on the other end of the port. `answers` lists the request types it replies to; any
 * other request goes unanswered, as older firmware relays an unknown type instead of answering.
 */
function rig(answers: Set<number>) {
  const log: [string, unknown][] = []
  const sent: number[] = []
  const svc = new HidCalibrationService(() => {}, {
    write: (b) => {
      const type = b[4]!
      const seq = b[5]!
      sent.push(type)
      const reply =
        type === CAL_TYPE.HELLO
          ? buildFrame(CAL_TYPE.HELLO_ACK, seq, HELLO_ACK)
          : type === CAL_TYPE.GET_CAL
            ? buildFrame(CAL_TYPE.CAL_DATA, seq, CAL_DATA)
            : type === CAL_TYPE.GET_DIAG
              ? buildFrame(CAL_TYPE.DIAG, seq, DIAG)
              : undefined
      if (reply && answers.has(type)) queueMicrotask(() => svc.ingest(Buffer.from(reply)))
    },
    serialNumber: async () => 'TESTSERIAL',
    cacheFile: noCache,
    log: (tag, data) => log.push([tag, data])
  })
  return { svc, log, sent, diagLogs: () => log.filter(([t]) => t === 'cal.diag') }
}

describe('GET_DIAG on connect (#169)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('asks right after HELLO and logs the decoded record with what it concludes', async () => {
    const { svc, sent, diagLogs } = rig(
      new Set([CAL_TYPE.HELLO, CAL_TYPE.GET_CAL, CAL_TYPE.GET_DIAG])
    )
    svc.attach()
    svc.opened()
    await vi.advanceTimersByTimeAsync(10)
    expect(sent).toEqual([CAL_TYPE.HELLO, CAL_TYPE.GET_DIAG, CAL_TYPE.GET_CAL])
    expect(diagLogs()).toHaveLength(1)
    expect(diagLogs()[0]![1]).toMatchObject({
      uptimeMs: 60_000,
      firstUartErrMs: 10_000,
      firstUsbLossMs: 20_000,
      usbReattaches: 1,
      resetReason: 'power-on',
      firstFault: 'uart',
      selfRecovered: true
    })
  })

  it('answers on demand with a fresh read, and the last read while the link is up', async () => {
    const { svc, sent } = rig(new Set([CAL_TYPE.HELLO, CAL_TYPE.GET_CAL, CAL_TYPE.GET_DIAG]))
    svc.attach()
    svc.opened()
    await vi.advanceTimersByTimeAsync(10)
    const p = svc.gatewayDiag(() => 1234)
    await vi.advanceTimersByTimeAsync(10)
    await expect(p).resolves.toMatchObject({ at: 1234, supported: true, firstFault: 'uart' })
    expect(sent.filter((t) => t === CAL_TYPE.GET_DIAG)).toHaveLength(2)
  })

  it('older firmware never answers: "not supported" once, no retry, the rest of connect goes on', async () => {
    const { svc, sent, diagLogs } = rig(new Set([CAL_TYPE.HELLO, CAL_TYPE.GET_CAL]))
    svc.attach()
    svc.opened()
    await vi.advanceTimersByTimeAsync(2000) // the request timeout
    await vi.advanceTimersByTimeAsync(10)
    expect(diagLogs()).toEqual([['cal.diag', { supported: false }]])
    expect(sent.filter((t) => t === CAL_TYPE.GET_DIAG)).toHaveLength(1)
    expect(sent).toContain(CAL_TYPE.GET_CAL) // calibration badges still read
    await vi.advanceTimersByTimeAsync(30_000)
    expect(
      sent.filter((t) => t === CAL_TYPE.GET_DIAG),
      'never asked again on its own'
    ).toHaveLength(1)
  })

  it('no HELLO answer (no calibration channel): no GET_DIAG either', async () => {
    const { svc, sent } = rig(new Set())
    svc.attach()
    svc.opened()
    await vi.advanceTimersByTimeAsync(2010)
    expect(sent).toEqual([CAL_TYPE.HELLO])
  })

  it('the record goes with the link: after release there is nothing to answer', async () => {
    const { svc } = rig(new Set([CAL_TYPE.HELLO, CAL_TYPE.GET_CAL, CAL_TYPE.GET_DIAG]))
    svc.attach()
    svc.opened()
    await vi.advanceTimersByTimeAsync(10)
    svc.release()
    await expect(svc.gatewayDiag()).resolves.toBeUndefined()
  })
})
