import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CAL_TYPE, buildFrame } from '../hid/calibration/codec'
import type { StreamRow } from '@shared/dcs'
import { eventText } from '@shared/format'
import type { LogEvent } from '@shared/events'
import type { CockpitSnapshot, NodeModel } from '@shared/nodes'
import { statusLine } from '../../test-fixtures/nodes'

// AppServices pulls in electron (debug log path), the serial port, the DCS transport and node-hid.
// Only the seams matter here, so each is replaced with something a test can drive directly.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

/** Stand-in for SerialBridge that exposes its callbacks so a test can act as the device. */
class FakeSerial {
  static last?: FakeSerial
  written: Buffer[] = []
  dataCb: (c: Buffer) => void = () => {}
  closeCb: () => void = () => {}
  openCb: (p: string) => void = () => {}
  errorCb: (e: Error) => void = () => {}
  stopped = false
  constructor() {
    FakeSerial.last = this
  }
  onData(cb: (c: Buffer) => void) {
    this.dataCb = cb
  }
  onMonitor() {}
  onError(cb: (e: Error) => void) {
    this.errorCb = cb
  }
  onOpen(cb: (p: string) => void) {
    this.openCb = cb
  }
  onClose(cb: () => void) {
    this.closeCb = cb
  }
  start() {}
  stop() {
    this.stopped = true
  }
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
  exportCb: (c: Buffer) => void = () => {}
  connectedCb: (c: boolean) => void = () => {}
  errorCb: (e: Error) => void = () => {}
  constructor() {
    FakeTransport.last = this
  }
  start() {}
  stop() {
    this.connectedCb(false) // as the real UDP transport does
  }
  send(d: Buffer) {
    this.sent.push(d)
  }
  onExport(cb: (c: Buffer) => void) {
    this.exportCb = cb
  }
  onError(cb: (e: Error) => void) {
    this.errorCb = cb
  }
  onConnected(cb: (c: boolean) => void) {
    this.connectedCb = cb
  }
}

vi.mock('../gateway/serial-bridge', () => ({
  SerialBridge: FakeSerial,
  PortNotFoundError: class extends Error {},
  SIMGATEWAY_VID: 0x2e8a,
  SIMGATEWAY_PID: 0x4134,
  findSimGatewayPort: () => Promise.resolve('/dev/fake'),
  listSerialPorts: () => Promise.resolve([{ path: '/dev/fake', serialNumber: 'TESTSERIAL' }])
}))
vi.mock('../dcs/transports', () => ({ createTransport: () => new FakeTransport() }))
// Keep the node mapping off the real disk.
vi.mock('../nodes/mapping-file', () => ({
  // Center_Armament and Right_Navigation are in this cockpit (#93: added).
  loadNodeMapping: () => ({
    file: { version: 3, nodes: { 1: { added: true }, 2: { added: true } } }
  }),
  saveNodeMapping: () => {},
  MappingSaveError: class extends Error {}
}))
vi.mock('../hid/hid-reader', () => ({
  HidReader: class {
    static last: InstanceType<typeof this> | undefined
    buttons: boolean[] = []
    private cb: () => void = () => {}
    constructor() {
      ;(this.constructor as { last?: unknown }).last = this
    }
    reopened = 0
    onError() {}
    onReport(cb: () => void) {
      this.cb = cb
    }
    start() {}
    reopen() {
      this.reopened++
    }
    stopped = false
    stop() {
      this.stopped = true
    }
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

const { AppServices } = await import('./app-services')
const { deviceToDcs, exportToDevice, relayConfigChanged } = await import('../dcs/relay-rules')
const { PortNotFoundError } = await import('../gateway/serial-bridge')
const { nodeRosterRequest } = await import('../nodes/node-status-wire')
const { DEFAULT_CONFIG } = await import('@shared/config')

const ascii = (s: string) => Buffer.from(s, 'ascii')

function bridgeSession() {
  const session = new AppServices(() => {})
  session.settings.update({ sourceMode: 'bridge' })
  session.open()
  FakeSerial.last!.openCb('/dev/fake') // a Bridge relay starts only with the board connected
  session.relay.start()
  const serial = FakeSerial.last!
  const transport = FakeTransport.last!
  transport.sent.length = 0 // drop the roster request seeded on open
  return { session, serial, transport }
}

describe('AppServices de-mux boundary', () => {
  beforeEach(() => {
    FakeSerial.last = undefined
    FakeTransport.last = undefined
  })

  it('relays ordinary device traffic to DCS untouched', () => {
    const { session, serial, transport } = bridgeSession()
    serial.dataCb(ascii('MASTER_ARM 1\n'))
    expect(Buffer.concat(transport.sent)).toEqual(ascii('MASTER_ARM 1\n'))
    session.shutdown()
  })

  it('keeps calibration frames out of the DCS command socket', () => {
    const { session, serial, transport } = bridgeSession()
    const frame = Buffer.from(buildFrame(CAL_TYPE.RAW, 1, Uint8Array.of(0, 1, 0, 2, 0)))
    serial.dataCb(Buffer.concat([ascii('ARM 1\n'), frame, ascii('FLAPS 0\n')]))
    // The frame is consumed; the text either side rejoins.
    expect(Buffer.concat(transport.sent)).toEqual(ascii('ARM 1\nFLAPS 0\n'))
    session.shutdown()
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
    session.shutdown()
  })

  it('does not re-feed flushed bytes through the de-mux', () => {
    // Flushing must not restart parsing: a held prefix that happens to complete a magic on the
    // next open would otherwise be swallowed as a frame that never existed.
    const { session, serial, transport } = bridgeSession()
    serial.dataCb(Buffer.from([0xaa, 0x53, 0x4b]))
    serial.closeCb()
    expect(Buffer.concat(transport.sent)).toEqual(Buffer.from([0xaa, 0x53, 0x4b]))
    session.shutdown()
  })

  it('emits nothing extra when the de-mux was holding nothing', () => {
    const { session, serial, transport } = bridgeSession()
    serial.dataCb(ascii('GEAR 0\n'))
    const before = Buffer.concat(transport.sent)
    serial.closeCb()
    expect(Buffer.concat(transport.sent)).toEqual(before)
    session.shutdown()
  })
})

describe('node telemetry tap', () => {
  it('feeds _NODE_TELEM to the node layer, not the command log, and still relays it', () => {
    vi.useFakeTimers()
    try {
      const pushes: [string, unknown][] = []
      const session = new AppServices((c, p) => pushes.push([c, p]))
      session.settings.update({ sourceMode: 'bridge' })
      session.open()
      const serial = FakeSerial.last!
      serial.openCb('/dev/fake') // node pushes flow only while the link is up
      session.relay.start()
      const transport = FakeTransport.last!
      transport.sent.length = 0

      // Each take of the pages redraws the Cockpit: NodeHub sends its snapshot as it takes them.
      const snaps = () =>
        pushes.filter(([c]) => c === 'cockpit:snapshot').map(([, p]) => p as CockpitSnapshot)
      const before = snaps().length

      // A real bridge line: OpenSkyhawk node_telem.cpp:13 @ 22b6a87e (node 3, 12 V rail).
      const line = '_NODE_TELEM 030100E02E182EBC02\n'
      serial.dataCb(ascii(line))
      expect(Buffer.concat(transport.sent)).toEqual(ascii(line)) // relay unchanged
      vi.advanceTimersByTime(250)

      const logged = pushes.filter(([c]) => c === 'log:batch').flatMap(([, p]) => p as StreamRow[])
      expect(logged.map((r) => r.name)).not.toContain('_NODE_TELEM')
      const perTake = snaps().length - before // the snapshots one take of the pages sends
      expect(perTake).toBeGreaterThan(0)
      // What `nodes:get` answers: the pages, taken by the node layer.
      expect(session.nodes.snapshot().telemetry).toEqual([
        expect.objectContaining({ nodeId: 3, isPdu: true, live: true })
      ])
      const model = pushes.filter(([c]) => c === 'nodes:model').at(-1)?.[1] as NodeModel
      expect(model.nodes.find((n) => n.nodeId === 3)).toMatchObject({
        name: 'PDU_Left',
        kind: 'pdu'
      })

      // A second frame inside the same second waits for the throttle, then is taken once.
      serial.dataCb(ascii(line))
      vi.advanceTimersByTime(250)
      expect(snaps()).toHaveLength(before + perTake)
      vi.advanceTimersByTime(1000)
      expect(snaps()).toHaveLength(before + 2 * perTake)
      session.shutdown()
    } finally {
      vi.useRealTimers()
    }
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
    const session = new AppServices((ch, payload) => {
      if (ch === 'hid:report') hidEvents.push([...(payload as { buttons: boolean[] }).buttons])
    })
    session.settings.update({ sourceMode: 'bridge' })
    session.open()
    session.relay.start()

    const { HidReader } = (await import('../hid/hid-reader')) as unknown as {
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

    session.shutdown()
    vi.useRealTimers()
  })
})

describe('HID recovery after an unplug', () => {
  it('reopens the HID handle when the serial port comes back', async () => {
    // The bug this exists for: pulling the cable killed HID permanently while serial reconnected
    // on its own, so the app looked healthy — link connected, DCS-BIOS traffic flowing — with the
    // axes frozen on their last values. Only stopping and restarting the relay revived it,
    // because that is the one path that constructs a new reader.
    //
    // The serial port reopening is the trigger rather than a node-hid error, because both
    // interfaces are the same physical device and a disconnect does not reliably surface as an
    // error event on every platform. Serial recovery is proven; being told is not.
    const { session, serial } = bridgeSession()
    const { HidReader } = (await import('../hid/hid-reader')) as unknown as {
      HidReader: { last?: { reopened: number } }
    }
    const hid = HidReader.last!
    const before = hid.reopened

    serial.openCb('/dev/fake') // the reconnect
    expect(hid.reopened).toBe(before + 1)

    session.shutdown()
  })
})

type Push = [string, unknown]

/** A session with the link open (app launched), the relay not started, and a recorder of pushes. */
function launched(
  config: Parameters<InstanceType<typeof AppServices>['settings']['update']>[0] = {}
) {
  const pushes: Push[] = []
  const session = new AppServices((c, p) => pushes.push([c, p]))
  session.settings.update(config)
  session.open()
  const serial = FakeSerial.last!
  const of = (channel: string) => pushes.filter(([c]) => c === channel).map(([, p]) => p)
  return { session, serial, pushes, of }
}

const HID = async () =>
  ((await import('../hid/hid-reader')) as unknown as { HidReader: { last?: { stopped: boolean } } })
    .HidReader.last!

describe('device link is independent of the relay (#69)', () => {
  beforeEach(() => {
    FakeSerial.last = undefined
    FakeTransport.last = undefined
  })

  it('opens on launch with no relay started', () => {
    const { session, serial, of } = launched()
    expect(serial, 'the port is opened without start()').toBeDefined()
    expect(session.status().device.state).toBe('scanning')
    serial.openCb('/dev/fake')
    expect(session.status().device).toMatchObject({ state: 'connected', portPath: '/dev/fake' })
    expect(session.status().running).toBe(false)
    expect(of('device:status').at(-1)).toMatchObject({ state: 'connected' })
    session.shutdown()
  })

  it('does not open the port on launch when auto-connect is off', () => {
    const { session, serial } = launched({ autoConnect: false })
    expect(serial).toBeUndefined()
    expect(session.status().device.state).toBe('disconnected')
    session.connection.connect() // the explicit Connect still works
    expect(FakeSerial.last).toBeDefined()
    session.shutdown()
  })

  it('leaves serial, HID and calibration up when the relay stops', async () => {
    const { session, serial } = launched({ sourceMode: 'bridge' })
    serial.openCb('/dev/fake')
    session.relay.start()
    session.relay.stop()
    expect(serial.stopped).toBe(false)
    expect((await HID()).stopped).toBe(false)
    expect(session.status().device.state).toBe('connected')
    // CalLink is still attached: an exchange is attempted rather than refused as offline.
    const hello = session.calibration.calHello()
    session.shutdown() // fails the in-flight exchange
    const r = await hello
    expect(r.ok ? 'ok' : r.kind).not.toBe('offline')
  })

  it('polls the node roster while the relay is stopped', () => {
    vi.useFakeTimers()
    try {
      const { session, serial } = launched()
      serial.openCb('/dev/fake')
      serial.written.length = 0
      vi.advanceTimersByTime(5000)
      expect(serial.written).toContainEqual(Buffer.from(nodeRosterRequest()))
      session.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not write the roster request while the link is down', () => {
    vi.useFakeTimers()
    try {
      const { session, serial } = launched()
      vi.advanceTimersByTime(5000)
      expect(serial.written).toEqual([])
      session.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps node pushes flowing after the relay stops (#71 finding 17)', () => {
    vi.useFakeTimers()
    try {
      const { session, serial, of } = launched({ sourceMode: 'bridge' })
      serial.openCb('/dev/fake')
      session.relay.start()
      session.relay.stop()
      const before = of('cockpit:snapshot').length
      serial.dataCb(ascii('_NODE_TELEM 030100E02E182EBC02\n'))
      vi.advanceTimersByTime(250)
      // The pages are taken (`nodes:get`), and the Cockpit snapshot goes out with them.
      expect(session.nodes.snapshot().telemetry).toEqual([expect.objectContaining({ nodeId: 3 })])
      expect(of('cockpit:snapshot').length).toBeGreaterThan(before)
      session.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops node pushes while unplugged, without clearing them', () => {
    vi.useFakeTimers()
    try {
      const { session, serial, of } = launched()
      serial.openCb('/dev/fake')
      vi.advanceTimersByTime(250)
      const models = of('nodes:model').length
      serial.closeCb()
      const snapshots = of('cockpit:snapshot').length // the close itself redraws the Cockpit
      serial.dataCb(ascii('_NODE_TELEM 030100E02E182EBC02\n')) // a late chunk
      vi.advanceTimersByTime(2000)
      expect(of('nodes:model'), 'no empty model pushed on close').toHaveLength(models)
      expect(of('cockpit:snapshot'), 'the late pages are not taken').toHaveLength(snapshots)
      session.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports an absent board as no-device, not as an error', () => {
    vi.useFakeTimers()
    try {
      const { session, serial, of } = launched()
      serial.errorCb(new PortNotFoundError())
      serial.errorCb(new PortNotFoundError())
      vi.advanceTimersByTime(100)
      expect(session.status().device.state).toBe('no-device')
      expect(of('device:status'), 'a repeated not-found is not news').toHaveLength(2) // scanning, no-device
      vi.advanceTimersByTime(100) // the event log flushes with the stream log
      const events = of('events:batch').flat() as LogEvent[]
      expect(events.filter((e) => e.severity === 'error')).toEqual([])
      session.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a port that will not open as an error, and Retry starts over', () => {
    const { session, serial } = launched()
    serial.errorCb(new Error('Access denied'))
    expect(session.status().device).toMatchObject({
      state: 'error',
      portPath: '/dev/fake',
      detail: 'Access denied'
    })
    session.connection.connect() // Retry
    expect(serial.stopped, 'the failed port is released').toBe(true)
    expect(FakeSerial.last).not.toBe(serial)
    expect(session.status().device.state).toBe('scanning')
    session.shutdown()
  })

  it.each([
    [
      'Disconnect then Connect',
      (s: InstanceType<typeof AppServices>) => {
        s.connection.disconnect()
        s.connection.connect()
      }
    ],
    [
      'an error then Retry',
      (s: InstanceType<typeof AppServices>, orphan: FakeSerial) => {
        orphan.errorCb(new Error('Access denied'))
        s.connection.connect()
      }
    ]
  ])('after %s, the released bridge no longer drives the link (M4)', (_, release) => {
    const { session, serial: orphan, of } = launched()
    release(session, orphan)
    const current = FakeSerial.last!
    expect(current, 'a fresh bridge').not.toBe(orphan)
    const pushed = of('device:status').length
    // The released bridge had an open in flight: it completes, then the port errors and closes.
    orphan.openCb('/dev/fake')
    orphan.dataCb(ascii('_NODE_STATUS_END\n'))
    orphan.errorCb(new Error('Access denied'))
    orphan.closeCb()
    expect(session.status().device.state, 'still looking with the fresh bridge').toBe('scanning')
    expect(of('device:status'), 'no status from the orphan').toHaveLength(pushed)
    expect(orphan.written, 'no roster request through the orphan').toEqual([])
    current.openCb('/dev/fake') // the current bridge still drives it
    expect(session.status().device.state).toBe('connected')
    session.shutdown()
  })

  it('ignores connect while the link is already open or looking', () => {
    const { session, serial } = launched()
    session.connection.connect()
    expect(FakeSerial.last).toBe(serial)
    serial.openCb('/dev/fake')
    session.connection.connect()
    expect(FakeSerial.last).toBe(serial)
    expect(serial.stopped).toBe(false)
    session.shutdown()
  })

  it('runs HID from launch even with auto-connect off', async () => {
    const { session } = launched({ autoConnect: false })
    expect((await HID()).stopped).toBe(false)
    session.shutdown()
    expect((await HID()).stopped).toBe(true)
  })

  it('reconnects after a drop, and stays down after one when auto-connect is off', () => {
    const on = launched()
    on.serial.openCb('/dev/fake')
    on.serial.closeCb()
    expect(on.session.status().device.state).toBe('reconnecting')
    expect(on.serial.stopped).toBe(false)
    on.session.shutdown()

    const off = launched()
    off.serial.openCb('/dev/fake')
    off.session.settings.update({ autoConnect: false }) // an open link is left alone
    expect(off.session.status().device.state).toBe('connected')
    off.serial.closeCb()
    expect(off.session.status().device.state).toBe('disconnected')
    expect(off.serial.stopped, 'the port is released, not retried').toBe(true)
    off.session.shutdown()
  })

  it('connects again when auto-connect is turned back on', () => {
    const { session } = launched({ autoConnect: false })
    expect(FakeSerial.last).toBeUndefined()
    session.settings.update({ autoConnect: true })
    expect(FakeSerial.last).toBeDefined()
    expect(session.status().device.state).toBe('scanning')
    session.shutdown()
  })

  it('disconnect releases the serial port until connect, and leaves HID running', async () => {
    const { session, serial } = launched()
    serial.openCb('/dev/fake')
    session.connection.disconnect()
    expect(serial.stopped).toBe(true)
    expect((await HID()).stopped, 'HID is shared with DCS and stays up').toBe(false)
    const cal = await session.calibration.calHello()
    expect(cal.ok ? 'ok' : cal.kind, 'calibration rides on serial').toBe('offline')
    expect(session.status().device.state).toBe('disconnected')
    session.connection.connect()
    expect(FakeSerial.last).not.toBe(serial)
    expect(session.status().device.state).toBe('scanning')
    session.shutdown()
  })

  // #159: it used to be refused ('Gateway is not connected'), the pill silently flipping back.
  it('starts with no board when the mode delivers to it, and waits for the board', () => {
    const { session, serial } = launched({ sourceMode: 'bridge' })
    expect(session.relay.start()).toEqual({ ok: true })
    expect(session.status().running).toBe(true)
    expect(FakeTransport.last, 'the DCS transport is opened').toBeDefined()
    expect(session.relay.facts().running.waiting, 'waiting for the Gateway').toBe('device')
    // The board arrives: delivery begins with no further Start.
    serial.openCb('/dev/fake')
    expect(session.relay.facts().running.waiting).not.toBe('device')
    serial.written.length = 0
    FakeTransport.last!.exportCb(Buffer.from([0x55, 0x55]))
    expect(Buffer.concat(serial.written)).toEqual(Buffer.from([0x55, 0x55]))
    expect(session.status().running).toBe(true)
    session.shutdown()
  })

  it('does not reconnect a released link on Start', () => {
    const { session, serial } = launched({ sourceMode: 'bridge' })
    serial.openCb('/dev/fake')
    session.connection.disconnect()
    expect(session.relay.start().ok, 'it starts, and waits for the board').toBe(true)
    expect(FakeSerial.last, 'Start leaves the link alone').toBe(serial)
    expect(session.status().device.state).toBe('disconnected')
    session.shutdown()
  })

  it('lets Monitor start with no board; Replay is refused only for having no capture', () => {
    const monitor = launched({ sourceMode: 'monitor' })
    expect(monitor.session.relay.start().ok).toBe(true)
    monitor.session.shutdown()

    // Replay, driven or not, is only refused for having no capture, never for the board (#159).
    const driven = launched({ sourceMode: 'replay', replayDriveSerial: true })
    expect(driven.session.relay.start()).toEqual({ ok: false, error: 'No capture loaded' })
    driven.session.shutdown()
    const plain = launched({ sourceMode: 'replay', replayDriveSerial: false })
    expect(plain.session.relay.start()).toEqual({ ok: false, error: 'No capture loaded' })
    plain.session.shutdown()
  })

  it('does not end a running relay when a setting changes during a drop', () => {
    const { session, serial } = launched({ sourceMode: 'bridge' })
    serial.openCb('/dev/fake')
    session.relay.start()
    serial.closeCb() // the board drops; the relay waits
    session.settings.update({ host: '10.0.0.2' }) // rebuilds the relay
    expect(session.status().running, 'only Stop ends a relay').toBe(true)
    session.shutdown()
  })

  it('keeps the relay running through a device drop', () => {
    const { session, serial } = launched({ sourceMode: 'bridge' })
    serial.openCb('/dev/fake')
    session.relay.start()
    serial.closeCb()
    expect(session.status().running, 'only Stop relay ends the relay').toBe(true)
    session.shutdown()
  })
})

describe('relay forwarding by source mode (#69)', () => {
  beforeEach(() => {
    FakeSerial.last = undefined
    FakeTransport.last = undefined
  })

  it('Monitor is read-only even though the port is open', () => {
    const { session, serial } = launched({ sourceMode: 'monitor' })
    serial.openCb('/dev/fake')
    session.relay.start()
    const transport = FakeTransport.last!
    serial.written.length = 0
    transport.exportCb(Buffer.from([0x55, 0x55, 0x55, 0x55]))
    expect(serial.written, 'no export reaches the device').toEqual([])
    serial.dataCb(ascii('MASTER_ARM 1\n'))
    expect(transport.sent, 'no panel command reaches DCS').toEqual([])
    session.shutdown()
  })

  it('Bridge forwards both ways while relaying', () => {
    const { session, serial } = launched({ sourceMode: 'bridge' })
    serial.openCb('/dev/fake')
    session.relay.start()
    const transport = FakeTransport.last!
    serial.written.length = 0
    transport.exportCb(Buffer.from([0x55, 0x55]))
    expect(Buffer.concat(serial.written)).toEqual(Buffer.from([0x55, 0x55]))
    serial.dataCb(ascii('MASTER_ARM 1\n'))
    expect(Buffer.concat(transport.sent)).toEqual(ascii('MASTER_ARM 1\n'))
    session.shutdown()
  })

  it('logs panel commands while stopped, without sending them anywhere', () => {
    vi.useFakeTimers()
    try {
      const { session, serial, of } = launched({ sourceMode: 'bridge' })
      serial.openCb('/dev/fake')
      serial.dataCb(ascii('MASTER_ARM 1\n'))
      vi.advanceTimersByTime(50)
      const logged = of('log:batch').flat() as StreamRow[]
      expect(logged).toContainEqual(expect.objectContaining({ name: 'MASTER_ARM', value: '1' }))
      expect(FakeTransport.last).toBeUndefined()
      session.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes export to the device in Bridge, and in Replay only when driving it', () => {
    const cfg = (sourceMode: 'bridge' | 'monitor' | 'replay', replayDriveSerial = false) => ({
      sourceMode,
      replayDriveSerial
    })
    expect(exportToDevice(cfg('bridge'))).toBe(true)
    expect(exportToDevice(cfg('monitor', true))).toBe(false)
    expect(exportToDevice(cfg('replay'))).toBe(false)
    expect(exportToDevice(cfg('replay', true))).toBe(true)
    expect(deviceToDcs(cfg('bridge'), true)).toBe(true)
    expect(deviceToDcs(cfg('bridge'), false)).toBe(false)
    expect(deviceToDcs(cfg('monitor'), true)).toBe(false)
    expect(deviceToDcs(cfg('replay', true), true)).toBe(false)
  })

  it('restarts a running relay only for settings the relay is built from', () => {
    const base = { ...DEFAULT_CONFIG }
    expect(relayConfigChanged(base, { ...base, host: '10.0.0.2' })).toBe(true)
    expect(relayConfigChanged(base, { ...base, sourceMode: 'bridge' })).toBe(true)
    expect(relayConfigChanged(base, { ...base, autoConnect: false })).toBe(false)
    expect(relayConfigChanged(base, { ...base, debugMode: true })).toBe(false)

    const { session } = launched()
    session.relay.start()
    const first = FakeTransport.last
    session.settings.update({ autoConnect: false })
    expect(FakeTransport.last, 'toggling auto-connect must not restart the relay').toBe(first)
    session.shutdown()
  })
})

describe('relay state (#69)', () => {
  it('reports the stream separately from the device', () => {
    const { session, of } = launched({ sourceMode: 'monitor' })
    session.relay.start()
    expect(of('relay:state').at(-1)).toEqual({ running: true, stream: 'connecting' })
    FakeTransport.last!.connectedCb(true)
    expect(of('relay:state').at(-1)).toEqual({ running: true, stream: 'connected' })
    FakeTransport.last!.connectedCb(false)
    expect(of('relay:state').at(-1)).toEqual({ running: true, stream: 'reconnecting' })
    session.relay.stop()
    expect(of('relay:state').at(-1)).toEqual({ running: false })
    expect(session.status().relay).toEqual({ running: false })
    expect(session.status().device.state, 'the device knows nothing of the relay').toBe('scanning')
    session.shutdown()
  })
})

describe('Gateway health (#94)', () => {
  beforeEach(() => {
    FakeSerial.last = undefined
    FakeTransport.last = undefined
  })

  const rows = (session: InstanceType<typeof AppServices>) =>
    session.journal.snapshot().map((e) => `${e.source}:${e.name}: ${eventText(e)}`)

  /** The Gateway's own row (node 0, kind 03, 42 °C), with these heartbeat flags. */
  const gatewayLine = (flags = 0): string =>
    `_NODE_STATUS 0001${flags.toString(16).padStart(2, '0')}0000000000002a00000003\n`

  it('carries its own row on device:status, and logs its flags', () => {
    vi.useFakeTimers()
    try {
      const { session, serial, of } = launched()
      serial.openCb('/dev/fake')
      serial.dataCb(ascii(gatewayLine() + '_NODE_STATUS_END\n'))
      vi.advanceTimersByTime(250)
      expect(session.status().device.gateway).toEqual({
        severity: 'ok',
        kind: 'ok',
        label: 'OK · 42 °C'
      })
      serial.dataCb(ascii(gatewayLine(0x01))) // bus-off
      vi.advanceTimersByTime(250)
      expect(of('device:status').at(-1)).toMatchObject({
        state: 'connected',
        gateway: { severity: 'err', kind: 'bus-off', label: 'Bus-off' }
      })
      expect(rows(session)).toContain('client:Gateway: bus-off')
      // Still never a cockpit node.
      const model = of('nodes:model').at(-1) as NodeModel
      expect(model.nodes.map((n) => n.nodeId)).not.toContain(0)
      session.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a roster request unanswered for 5 s is "not responding", until it answers', () => {
    vi.useFakeTimers()
    try {
      const { session, serial } = launched()
      serial.openCb('/dev/fake') // seeds the first roster request
      serial.dataCb(ascii('_NODE_STATUS_END\n')) // answered: from here it can stop answering
      vi.advanceTimersByTime(9800) // the 5 s poll goes out and is never answered
      expect(session.status().device.gateway).toBeUndefined()
      vi.advanceTimersByTime(400)
      expect(session.status().device).toMatchObject({
        state: 'connected', // a Gateway problem, not a link state change
        gateway: { severity: 'err', kind: 'not-responding' }
      })
      serial.dataCb(ascii('_NODE_STATUS_END\n'))
      vi.advanceTimersByTime(250)
      expect(session.status().device.gateway).toBeUndefined()
      expect(
        rows(session).filter((r) => r.startsWith('client:Gateway: ') && !r.includes('connected'))
      ).toEqual([
        'client:Gateway: not responding · no answer for 5 s',
        'client:Gateway: responding again'
      ])
      session.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never "not responding" for a Gateway that has not answered since the port opened', () => {
    vi.useFakeTimers()
    try {
      const { session, serial } = launched()
      serial.openCb('/dev/fake') // e.g. firmware built without node status: no roster replies
      vi.advanceTimersByTime(30_000)
      expect(session.status().device.gateway).toBeUndefined()
      expect(rows(session).some((r) => r.includes('not responding'))).toBe(false)
      session.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('is gone while the link is down, and starts over on the next open', () => {
    vi.useFakeTimers()
    try {
      const { session, serial } = launched()
      serial.openCb('/dev/fake')
      serial.dataCb(ascii(gatewayLine(0x02)))
      vi.advanceTimersByTime(250)
      expect(session.status().device.gateway?.kind).toBe('error-passive')
      serial.closeCb()
      expect(session.status().device.gateway).toBeUndefined()
      vi.advanceTimersByTime(10_000) // no "not responding" while the port is closed
      serial.openCb('/dev/fake')
      expect(session.status().device.gateway).toBeUndefined()
      expect(rows(session).some((r) => r.includes('not responding'))).toBe(false)
      session.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('event log (#64)', () => {
  beforeEach(() => {
    FakeSerial.last = undefined
    FakeTransport.last = undefined
  })

  const rows = (session: InstanceType<typeof AppServices>) =>
    session.journal.snapshot().map((e) => `${e.source}:${e.name}: ${eventText(e)}`)

  it('moves link errors out of the stream log into client events', () => {
    vi.useFakeTimers()
    try {
      const { session, serial, of } = launched()
      serial.errorCb(new Error('Access denied'))
      vi.advanceTimersByTime(100)
      expect(of('log:batch').flat()).toEqual([])
      // One row: the device state "error" repeats what the SERIAL error says.
      expect(rows(session)).toEqual(['client:SERIAL: serial port error · Access denied'])
      expect((of('events:batch').flat() as LogEvent[]).map((e) => e.raw)).toEqual([
        'SERIAL Error: Access denied'
      ])
      session.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('records the device link, the roster baseline and node changes with their source line', () => {
    const { session, serial } = launched()
    serial.openCb('/dev/fake')
    serial.dataCb(Buffer.from(statusLine(1) + statusLine(2) + '_NODE_STATUS_END\n'))
    serial.dataCb(Buffer.from(statusLine(2, false)))
    serial.closeCb()
    expect(rows(session)).toEqual([
      'client:Gateway: connected · /dev/fake',
      'node:roster: 2 nodes online',
      'node:Right_Navigation: offline · no heartbeat',
      'client:Gateway: reconnecting · link dropped'
    ])
    const offline = session.journal.snapshot()[2]
    expect(offline.nodeId).toBe(2)
    expect(offline.raw).toBe(statusLine(2, false).trim())
    session.shutdown()
  })

  it('a v2 bridge is reported once, loudly, instead of an empty Cockpit', () => {
    const { session, serial } = launched()
    serial.openCb('/dev/fake')
    const v2 = '_NODE_STATUS 01010000000000000080000000\n' // 26 hex: no nodeKind
    serial.dataCb(Buffer.from(v2 + v2 + '_NODE_STATUS_END 1\n'))
    const errs = rows(session).filter((r) => r.includes('needs v3'))
    expect(errs).toHaveLength(1)
    session.shutdown()
  })

  it("tolerates reset noise before the bridge's own row, and leaves that row out of the counts", () => {
    const { session, serial } = launched()
    serial.openCb('/dev/fake')
    serial.dataCb(
      Buffer.concat([
        Buffer.from([0x5f, 0xfe]), // '_\xfe', as captured on the bench
        Buffer.from(statusLine(0, true, 3) + statusLine(1) + '_NODE_STATUS_END 2\n')
      ])
    )
    expect(rows(session)).toContain('node:roster: 1 node online')
    expect(rows(session).some((r) => r.includes('Node 0'))).toBe(false)
    session.shutdown()
  })

  it('a retry loop is one row per error, even with two loops interleaved', () => {
    const { session, serial } = launched({ sourceMode: 'monitor' })
    session.relay.start()
    const t = FakeTransport.last!
    for (let i = 0; i < 3; i++) {
      serial.errorCb(new Error('Cannot lock port'))
      t.errorCb(new Error('connect ECONNREFUSED'))
      t.connectedCb(false)
    }
    expect(rows(session).filter((r) => r.includes('error'))).toEqual([
      'client:SERIAL: serial port error · Cannot lock port',
      'client:DCS: link error · connect ECONNREFUSED'
    ])
    expect(rows(session).filter((r) => r.includes('reconnecting'))).toEqual([])
    session.shutdown()
  })

  it('a DCS link that came up and dropped reports its next error again (review of #86)', () => {
    const { session } = launched({ sourceMode: 'monitor' })
    session.relay.start()
    const t = FakeTransport.last!
    t.errorCb(new Error('connect ECONNREFUSED')) // started before DCS
    t.connectedCb(true) // DCS starts: link up
    t.connectedCb(false) // DCS quits
    t.errorCb(new Error('connect ECONNREFUSED'))
    t.errorCb(new Error('connect ECONNREFUSED')) // its retry loop: no further row
    expect(rows(session).filter((r) => r.startsWith('client:DCS'))).toEqual([
      'client:DCS: link error · connect ECONNREFUSED',
      'client:DCS: link up · 127.0.0.1:7778',
      'client:DCS: reconnecting · 127.0.0.1:7778',
      'client:DCS: link error · connect ECONNREFUSED'
    ])
    session.shutdown()
  })

  it('Disconnect then Connect reports the same port failure again (review of #86)', () => {
    const { session, serial } = launched()
    serial.errorCb(new Error('Cannot lock port'))
    serial.errorCb(new Error('Cannot lock port')) // the port's own retry loop
    session.connection.disconnect()
    session.connection.connect()
    FakeSerial.last!.errorCb(new Error('Cannot lock port'))
    expect(rows(session)).toEqual([
      'client:SERIAL: serial port error · Cannot lock port',
      'client:Gateway: disconnected',
      'client:SERIAL: serial port error · Cannot lock port'
    ])
    session.shutdown()
  })

  it('records relay start and stop', () => {
    const { session, serial } = launched({ sourceMode: 'monitor' })
    serial.openCb('/dev/fake')
    session.relay.start()
    FakeTransport.last!.connectedCb(true)
    session.relay.stop()
    expect(rows(session).slice(1)).toEqual([
      'client:Relay: started · Monitor mode',
      'client:DCS: link up · 127.0.0.1:7778',
      'client:Relay: stopped'
    ])
    session.shutdown()
  })
})
