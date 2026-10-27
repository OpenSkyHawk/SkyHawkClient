// SESSION-seam tests for the Gateway's link health (#169), through the services harness: a
// simulated Gateway answers the calibration frames the app writes (HELLO, GET_CAL and, on newer
// firmware, GET_DIAG), and the test reads only pushes, intents and wire bytes.
import { describe, expect, it, vi } from 'vitest'
import { CTRL } from '@shared/app'
import type { GatewayLinkHealth } from '@shared/gateway'
import { makeServices, type Services } from '../test-harness/services'

// After the harness, so main is loaded against its fakes.
const { CAL_TYPE, buildFrame } = await import('../hid/calibration/codec')

const MAGIC = Buffer.from([0xaa, 0x53, 0x4b, 0x43])
const HELLO_ACK = Uint8Array.of(1, 1, 8, 0, 2, 0)
const CAL_DATA = new Uint8Array(82)
/** DIAG: up 60 s, a UART error at 10 s then a USB loss at 20 s, one software re-plug. */
const DIAG = (() => {
  const p = new Uint8Array(64)
  const v = new DataView(p.buffer)
  v.setUint32(0, 60_000, true) // UPTIME_MS
  v.setUint32(4, 10_000, true) // FIRST_UART_ERR_MS
  v.setUint32(12, 20_000, true) // FIRST_USB_LOSS_MS
  v.setUint16(40, 1, true) // USB_REATTACHES
  return p
})()

/**
 * The Gateway's end of the calibration channel. It answers HELLO and GET_CAL, and GET_DIAG only
 * when `diag` is on: older firmware relays an unknown type instead of answering, so it stays silent.
 */
function gateway(app: Services, diag: boolean) {
  let seen = 0
  const asked: number[] = []
  const answer = () => {
    const wire = Buffer.concat(app.serial.written())
    for (let at = wire.indexOf(MAGIC, seen); at !== -1; at = wire.indexOf(MAGIC, at + 1)) {
      if (at + 8 > wire.length) break
      const type = wire[at + 4]!
      const seq = wire[at + 5]!
      const len = wire.readUInt16LE(at + 6)
      if (at + 10 + len > wire.length) break
      seen = at + 10 + len
      asked.push(type)
      if (type === CAL_TYPE.HELLO)
        app.serial.receive(buildFrame(CAL_TYPE.HELLO_ACK, seq, HELLO_ACK))
      if (type === CAL_TYPE.GET_CAL)
        app.serial.receive(buildFrame(CAL_TYPE.CAL_DATA, seq, CAL_DATA))
      if (type === CAL_TYPE.GET_DIAG && diag)
        app.serial.receive(buildFrame(CAL_TYPE.DIAG, seq, DIAG))
    }
  }
  /** Let main run for `ms`, answering whatever it asks on the way. */
  const run = async (ms: number) => {
    for (let t = 0; t < ms; t += 10) {
      await vi.advanceTimersByTimeAsync(10)
      answer()
    }
  }
  const calAsks = () => asked.filter((t) => t < 0x80)
  return { run, calAsks }
}

const health = (app: Services): GatewayLinkHealth | undefined =>
  app.lastPush('device:status')?.linkHealth

describe('the Gateway link health (#169)', () => {
  it('is read with GET_DIAG right after HELLO on connect, and rides on device:status', async () => {
    const app = makeServices()
    const gw = gateway(app, true)
    app.serial.open()
    await gw.run(200)
    expect(gw.calAsks().slice(0, 3)).toEqual([CAL_TYPE.HELLO, CAL_TYPE.GET_DIAG, CAL_TYPE.GET_CAL])
    expect(health(app)).toMatchObject({
      supported: true,
      diag: { uptimeMs: 60_000, firstUartErrMs: 10_000, firstUsbLossMs: 20_000, usbReattaches: 1 },
      resetReason: 'power-on',
      firstFault: 'uart',
      selfRecovered: true
    })
  })

  it('a refresh reads it again; the answer comes as a push, not as the intent’s reply', async () => {
    const app = makeServices()
    const gw = gateway(app, true)
    app.serial.open()
    await gw.run(200)
    const before = health(app)!.at
    await vi.advanceTimersByTimeAsync(5_000)
    const done = app.invoke(CTRL.deviceDiagRefresh)
    await gw.run(200)
    await expect(done).resolves.toBeUndefined()
    expect(gw.calAsks().filter((t) => t === CAL_TYPE.GET_DIAG)).toHaveLength(2)
    expect(health(app)!.at).toBeGreaterThan(before)
  })

  it('older firmware never answers: "not supported" once, no retry, the rest of connect goes on', async () => {
    const app = makeServices()
    const gw = gateway(app, false)
    app.serial.open()
    await gw.run(2_500) // past the 2 s request timeout
    expect(health(app)).toEqual({ at: expect.any(Number), supported: false })
    expect(gw.calAsks()).toContain(CAL_TYPE.GET_CAL) // the calibration badges still read
    await gw.run(30_000)
    expect(
      gw.calAsks().filter((t) => t === CAL_TYPE.GET_DIAG),
      'never asked again on its own'
    ).toHaveLength(1)
  })

  it('goes with the link: an unplug drops it, and a refresh while down asks nothing', async () => {
    const app = makeServices()
    const gw = gateway(app, true)
    app.serial.open()
    await gw.run(200)
    expect(health(app)).toBeDefined()
    app.serial.close()
    expect(health(app)).toBeUndefined()
    const asks = gw.calAsks().length
    await app.invoke(CTRL.deviceDiagRefresh)
    await gw.run(100)
    expect(gw.calAsks()).toHaveLength(asks)
  })
})
