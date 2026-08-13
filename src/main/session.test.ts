import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CAL_TYPE, buildFrame } from '@shared/calibration'

// Session pulls in electron (debug log path), the serial port, the DCS transport and node-hid.
// Only the seams matter here, so each is replaced with something a test can drive directly.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

/** Stand-in for SerialBridge that exposes its callbacks so a test can act as the device. */
class FakeSerial {
  static last?: FakeSerial
  written: Buffer[] = []
  dataCb: (c: Buffer) => void = () => {}
  closeCb: () => void = () => {}
  openCb: (p: string) => void = () => {}
  constructor() {
    FakeSerial.last = this
  }
  onData(cb: (c: Buffer) => void) {
    this.dataCb = cb
  }
  onMonitor() {}
  onError() {}
  onOpen(cb: (p: string) => void) {
    this.openCb = cb
  }
  onClose(cb: () => void) {
    this.closeCb = cb
  }
  start() {}
  stop() {}
  write(d: Buffer) {
    this.written.push(d)
  }
  portPath() {
    return '/dev/fake'
  }
}

/** Captures what would go to DCS. */
class FakeTransport {
  static last?: FakeTransport
  sent: Buffer[] = []
  constructor() {
    FakeTransport.last = this
  }
  start() {}
  stop() {}
  send(d: Buffer) {
    this.sent.push(d)
  }
  onExport() {}
  onError() {}
  onConnected() {}
}

vi.mock('./serial', () => ({
  SerialBridge: FakeSerial,
  SIMGATEWAY_VID: 0x2e8a,
  SIMGATEWAY_PID: 0x4134,
  findSimGatewayPort: () => Promise.resolve('/dev/fake'),
  listSerialPorts: () => Promise.resolve([{ path: '/dev/fake', serialNumber: 'TESTSERIAL' }])
}))
vi.mock('./net', () => ({ createTransport: () => new FakeTransport() }))
vi.mock('./hid', () => ({
  HidReader: class {
    static last: InstanceType<typeof this> | undefined
    buttons: boolean[] = []
    private cb: () => void = () => {}
    constructor() {
      ;(this.constructor as { last?: unknown }).last = this
    }
    onError() {}
    onReport(cb: () => void) {
      this.cb = cb
    }
    start() {}
    stop() {}
    sampleRate() {}
    /** Stand in for a report arriving from the device. */
    fire(buttons: boolean[]) {
      this.buttons = buttons
      this.cb()
    }
    snapshot() {
      return { axes: [], buttons: this.buttons, hats: [], ageMs: 0, rateHz: 0 }
    }
  }
}))

const { Session } = await import('./session')

const ascii = (s: string) => Buffer.from(s, 'ascii')

function bridgeSession() {
  const session = new Session(() => {})
  session.setConfig({ sourceMode: 'bridge' })
  session.start()
  const serial = FakeSerial.last!
  const transport = FakeTransport.last!
  transport.sent.length = 0 // drop the roster request seeded on open
  return { session, serial, transport }
}

describe('Session de-mux boundary', () => {
  beforeEach(() => {
    FakeSerial.last = undefined
    FakeTransport.last = undefined
  })

  it('relays ordinary device traffic to DCS untouched', () => {
    const { session, serial, transport } = bridgeSession()
    serial.dataCb(ascii('MASTER_ARM 1\n'))
    expect(Buffer.concat(transport.sent)).toEqual(ascii('MASTER_ARM 1\n'))
    session.stop()
  })

  it('keeps calibration frames out of the DCS command socket', () => {
    const { session, serial, transport } = bridgeSession()
    const frame = Buffer.from(buildFrame(CAL_TYPE.RAW, 1, Uint8Array.of(0, 1, 0, 2, 0)))
    serial.dataCb(Buffer.concat([ascii('ARM 1\n'), frame, ascii('FLAPS 0\n')]))
    // The frame is consumed; the text either side rejoins.
    expect(Buffer.concat(transport.sent)).toEqual(ascii('ARM 1\nFLAPS 0\n'))
    session.stop()
  })

  it('forwards bytes the de-mux was still holding when the port closes', () => {
    // The regression this exists for: close() flushes an incomplete candidate, and discarding
    // it silently removes those bytes from the DCS relay and the line assembler. CalLink's own
    // test only proves close() RETURNS them, which is why this assertion lives here.
    const { session, serial, transport } = bridgeSession()

    // A bare 0xAA is exactly what the gateway emits on its parser resync, and it is held as a
    // possible magic prefix rather than passed straight through.
    serial.dataCb(Buffer.concat([ascii('LANDING 1\n'), Buffer.from([0xaa, 0x53])]))
    expect(Buffer.concat(transport.sent)).toEqual(ascii('LANDING 1\n'))

    serial.closeCb()
    expect(
      Buffer.concat(transport.sent),
      'the held candidate belongs to the DCS stream, not the bin'
    ).toEqual(Buffer.concat([ascii('LANDING 1\n'), Buffer.from([0xaa, 0x53])]))
    session.stop()
  })

  it('does not re-feed flushed bytes through the de-mux', () => {
    // Flushing must not restart parsing: a held prefix that happens to complete a magic on the
    // next open would otherwise be swallowed as a frame that never existed.
    const { session, serial, transport } = bridgeSession()
    serial.dataCb(Buffer.from([0xaa, 0x53, 0x4b]))
    serial.closeCb()
    expect(Buffer.concat(transport.sent)).toEqual(Buffer.from([0xaa, 0x53, 0x4b]))
    session.stop()
  })

  it('emits nothing extra when the de-mux was holding nothing', () => {
    const { session, serial, transport } = bridgeSession()
    serial.dataCb(ascii('GEAR 0\n'))
    const before = Buffer.concat(transport.sent)
    serial.closeCb()
    expect(Buffer.concat(transport.sent)).toEqual(before)
    session.stop()
  })
})

describe('HID reporting latency', () => {
  it('pushes a press as it arrives, and does not swallow the release behind it', async () => {
    // Both halves of the throttle are load-bearing. Emitting only on the leading edge shows the
    // press instantly but loses a release that lands inside the same window — a quick tap then
    // reads as a stuck button. Emitting only on the trailing edge keeps every transition but
    // puts the delay back on the press, which is what made this feel unresponsive against a
    // reference HID tester in the first place.
    vi.useFakeTimers()
    const hidEvents: boolean[][] = []
    const session = new Session((ch, payload) => {
      if (ch === 'hid:report') hidEvents.push([...(payload as { buttons: boolean[] }).buttons])
    })
    session.setConfig({ sourceMode: 'bridge' })
    session.start()

    const { HidReader } = (await import('./hid')) as unknown as {
      HidReader: { last?: { fire(b: boolean[]): void } }
    }
    const hid = HidReader.last!

    hid.fire([true])
    expect(hidEvents, 'the press is visible without waiting for a timer').toEqual([[true]])

    // Released 5 ms later — well inside the throttle window, and far inside the 200 ms telemetry
    // tick that used to be the only thing pushing HID state.
    vi.advanceTimersByTime(5)
    hid.fire([false])
    vi.advanceTimersByTime(15)
    expect(hidEvents.at(-1), 'the release still lands').toEqual([false])

    session.stop()
    vi.useRealTimers()
  })
})
