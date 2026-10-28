// SESSION-seam tests for the Gateway's link health (#169), through the services harness: a
// simulated Gateway answers the calibration frames the app writes (HELLO, GET_CAL and, on newer
// firmware, GET_DIAG), and the test reads only pushes, intents and wire bytes.
import { describe, expect, it, vi } from 'vitest'
import { CTRL } from '@shared/app'
import { CAL_DIAG_FIELD, CAL_DIAG_RESET_REASONS } from '@shared/firmware'
import { makeServices, type Services } from '../test-harness/services'

// After the harness, so main is loaded against its fakes.
const { CAL_TYPE, buildFrame, crc16 } = await import('../hid/calibration/codec')
const { diagPayload } = await import('../../test-fixtures/diag')
type DiagFields = Parameters<typeof diagPayload>[0]

const MAGIC = Buffer.from([0xaa, 0x53, 0x4b, 0x43])
const HELLO_ACK = Uint8Array.of(1, 1, 8, 0, 2, 0)
const CAL_DATA = new Uint8Array(82)
/** DIAG: a UART error at 10 s then a USB loss at 20 s, one software re-plug. */
const RECOVERED: DiagFields = {
  FIRST_UART_ERR_MS: 10_000,
  FIRST_USB_LOSS_MS: 20_000,
  USB_REATTACHES: 1
}
/** DIAG after a cold start with nothing to tell. */
const CLEAN: DiagFields = { RESET_REASON: CAL_DIAG_RESET_REASONS.POWER_ON }

/**
 * Firmware 0.2.0's DIAG: the bytes up to RESERVED, in a well-formed envelope. The demux takes no
 * frame of that length for DIAG, so the bytes go on to the stream and the read times out.
 */
const short = (seq: number): Buffer => {
  const p = diagPayload(RECOVERED).slice(0, CAL_DIAG_FIELD.RESERVED)
  const body = Buffer.from([CAL_TYPE.DIAG, seq, p.length & 0xff, p.length >> 8, ...p])
  const c = crc16(body)
  return Buffer.concat([MAGIC, body, Buffer.from([c & 0xff, c >> 8])])
}

/**
 * The Gateway's end of the calibration channel, booted a minute ago. It answers GET_CAL, HELLO
 * unless `hello` is off, and GET_DIAG per `diag`: these fields with its uptime now, firmware
 * 0.2.0's shorter record, or nothing (older firmware relays an unknown type instead of answering,
 * so it stays silent).
 */
function gateway(app: Services, opts: { hello?: boolean; diag: DiagFields | 'short' | 'none' }) {
  const bootAt = Date.now() - 60_000
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
      if (type === CAL_TYPE.HELLO && opts.hello !== false)
        app.serial.receive(buildFrame(CAL_TYPE.HELLO_ACK, seq, HELLO_ACK))
      if (type === CAL_TYPE.GET_CAL)
        app.serial.receive(buildFrame(CAL_TYPE.CAL_DATA, seq, CAL_DATA))
      if (type === CAL_TYPE.GET_DIAG) diag(seq)
    }
  }
  const diag = (seq: number): void => {
    const d = opts.diag
    if (d === 'none') return
    if (d === 'short') return app.serial.receive(short(seq))
    const p = diagPayload({ ...d, UPTIME_MS: Date.now() - bootAt })
    app.serial.receive(buildFrame(CAL_TYPE.DIAG, seq, p))
  }
  /** Let main run for `ms`, answering whatever it asks on the way. */
  const run = async (ms: number) => {
    for (let t = 0; t < ms; t += 10) {
      await vi.advanceTimersByTimeAsync(10)
      answer()
    }
  }
  const calAsks = () => asked.filter((t) => t < 0x80)
  const diagAsks = () => asked.filter((t) => t === CAL_TYPE.GET_DIAG).length
  return { run, calAsks, diagAsks }
}

/** What device:status says about the Gateway now. */
const status = (app: Services) => app.lastPush('device:status')
/** The Gateway's "recovered itself" rows in Log › Events. */
const recoveryRows = async (app: Services) =>
  (await app.invoke(CTRL.eventsGet)).filter(
    (e) => e.name === 'Gateway' && e.event === 'recovered itself'
  )

describe('the Gateway recovered itself (#169)', () => {
  it('gateway-diag.seam.recovered: read after HELLO; the Gateway status carries it, one Events row, no record on device:status', async () => {
    const app = makeServices()
    const gw = gateway(app, { diag: RECOVERED })
    app.serial.open()
    await gw.run(400)
    expect(gw.calAsks().slice(0, 3)).toEqual([CAL_TYPE.HELLO, CAL_TYPE.GET_DIAG, CAL_TYPE.GET_CAL])
    expect(status(app)?.gateway).toMatchObject({
      severity: 'warn',
      kind: 'unreported', // nothing from its cockpit side in this test
      recovered: { how: 're-plug' }
    })
    expect(status(app)?.gateway?.alert).toBeUndefined()
    expect(app.pushesOf('device:status').every((s) => !('linkHealth' in s))).toBe(true)
    const rows = await recoveryRows(app)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source: 'client',
      severity: 'warn',
      detail: 're-plugged itself to recover its link to this computer'
    })
  })

  it('gone with the link; a reconnect to the same boot shows it again with no second row', async () => {
    const app = makeServices()
    const gw = gateway(app, { diag: RECOVERED })
    app.serial.open()
    await gw.run(400)
    app.serial.close()
    await gw.run(100)
    expect(status(app)?.gateway).toBeUndefined()
    await gw.run(3_000) // the link reopens the port by itself
    app.serial.open()
    await gw.run(400)
    expect(gw.diagAsks()).toBe(2)
    expect(status(app)?.gateway?.recovered?.how).toBe('re-plug')
    expect(await recoveryRows(app)).toHaveLength(1)
  })

  it('a clean read: no status, no row', async () => {
    const app = makeServices()
    const gw = gateway(app, { diag: CLEAN })
    app.serial.open()
    await gw.run(400)
    expect(gw.diagAsks()).toBe(1)
    expect(status(app)?.gateway).toBeUndefined()
    expect(await recoveryRows(app)).toEqual([])
  })

  it('gateway-diag.seam.no-hello: no HELLO answer → no GET_DIAG, nothing recovered', async () => {
    const app = makeServices()
    const gw = gateway(app, { hello: false, diag: RECOVERED })
    app.serial.open()
    await gw.run(5_000) // past the HELLO timeout
    expect(gw.calAsks()).toContain(CAL_TYPE.HELLO)
    expect(gw.diagAsks()).toBe(0)
    expect(status(app)?.gateway).toBeUndefined()
    expect(await recoveryRows(app)).toEqual([])
  })

  it('gateway-diag.seam.connect-only: never asked again while the link stays up', async () => {
    const app = makeServices()
    const gw = gateway(app, { diag: RECOVERED })
    app.serial.open()
    await gw.run(60_000)
    expect(gw.diagAsks()).toBe(1)
  })

  it('older firmware never answers: "not supported" once, no retry, the rest of connect goes on', async () => {
    const app = makeServices()
    const gw = gateway(app, { diag: 'none' })
    app.serial.open()
    await gw.run(2_500) // past the 2 s request timeout
    expect(gw.calAsks()).toContain(CAL_TYPE.GET_CAL) // the calibration badges still read
    expect(status(app)?.gateway).toBeUndefined()
    await gw.run(30_000)
    expect(gw.diagAsks(), 'never asked again on its own').toBe(1)
  })

  it('codec.diag-047: a firmware 0.2.0 DIAG is no reply; the read ends "not supported"', async () => {
    const app = makeServices()
    const gw = gateway(app, { diag: 'short' })
    app.serial.open()
    await gw.run(2_500)
    expect(gw.calAsks()).toContain(CAL_TYPE.GET_CAL)
    expect(status(app)?.gateway).toBeUndefined()
    expect(await recoveryRows(app)).toEqual([])
    expect(gw.diagAsks()).toBe(1)
  })
})
