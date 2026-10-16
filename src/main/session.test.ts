import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CAL_TYPE, buildFrame } from '@shared/calibration'
import type { LogRow } from '@shared/ipc'
import type { NodeModel } from '@shared/node-rules'

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
  onError() {}
  onConnected(cb: (c: boolean) => void) {
    this.connectedCb = cb
  }
}

vi.mock('./serial', () => ({
  SerialBridge: FakeSerial,
  PortNotFoundError: class extends Error {},
  SIMGATEWAY_VID: 0x2e8a,
  SIMGATEWAY_PID: 0x4134,
  findSimGatewayPort: () => Promise.resolve('/dev/fake'),
  listSerialPorts: () => Promise.resolve([{ path: '/dev/fake', serialNumber: 'TESTSERIAL' }])
}))
vi.mock('./net', () => ({ createTransport: () => new FakeTransport() }))
// Keep the node mapping off the real disk.
vi.mock('./node-mapping', () => ({
  loadNodeMapping: () => ({ file: { version: 1, nodes: {}, ignored: [] } }),
  saveNodeMapping: () => {},
  MappingSaveError: class extends Error {}
}))
vi.mock('./hid', () => ({
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

const { Session, deviceToDcs, exportToDevice, relayConfigChanged } = await import('./session')
const { PortNotFoundError } = await import('./serial')
const { nodeRosterRequest } = await import('@shared/nodes')
const { DEFAULT_CONFIG } = await import('@shared/ipc')

const ascii = (s: string) => Buffer.from(s, 'ascii')

function bridgeSession() {
  const session = new Session(() => {})
  session.setConfig({ sourceMode: 'bridge' })
  session.open()
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
      const session = new Session((c, p) => pushes.push([c, p]))
      session.setConfig({ sourceMode: 'bridge' })
      session.open()
      session.start()
      const serial = FakeSerial.last!
      serial.openCb('/dev/fake') // node pushes flow only while the link is up
      const transport = FakeTransport.last!
      transport.sent.length = 0

      // A real bridge line: OpenSkyhawk node_telem.cpp:13 @ 22b6a87e (node 3, 12 V rail).
      const line = '_NODE_TELEM 030100E02E182EBC02\n'
      serial.dataCb(ascii(line))
      expect(Buffer.concat(transport.sent)).toEqual(ascii(line)) // relay unchanged
      vi.advanceTimersByTime(250)

      const logged = pushes.filter(([c]) => c === 'log:batch').flatMap(([, p]) => p as LogRow[])
      expect(logged.map((r) => r.name)).not.toContain('_NODE_TELEM')
      const telem = pushes.filter(([c]) => c === 'nodes:telemetry')
      expect(telem).toHaveLength(1)
      expect(telem[0]![1]).toEqual([
        expect.objectContaining({ nodeId: 3, isPdu: true, live: true })
      ])
      const model = pushes.filter(([c]) => c === 'nodes:model').at(-1)?.[1] as NodeModel
      expect(model.nodes.find((n) => n.nodeId === 3)).toMatchObject({
        name: 'PDU_Left',
        kind: 'pdu'
      })

      // A second frame inside the same second waits for the throttle.
      serial.dataCb(ascii(line))
      vi.advanceTimersByTime(250)
      expect(pushes.filter(([c]) => c === 'nodes:telemetry')).toHaveLength(1)
      vi.advanceTimersByTime(1000)
      expect(pushes.filter(([c]) => c === 'nodes:telemetry')).toHaveLength(2)
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
    const session = new Session((ch, payload) => {
      if (ch === 'hid:report') hidEvents.push([...(payload as { buttons: boolean[] }).buttons])
    })
    session.setConfig({ sourceMode: 'bridge' })
    session.open()
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
    const { HidReader } = (await import('./hid')) as unknown as {
      HidReader: { last?: { reopened: number } }
    }
    const hid = HidReader.last!
    expect(hid.reopened, 'nothing to reopen on the first open').toBe(0)

    serial.openCb('/dev/fake') // the reconnect
    expect(hid.reopened).toBe(1)

    session.shutdown()
  })
})

type Push = [string, unknown]

/** A session with the link open (app launched), the relay not started, and a recorder of pushes. */
function launched(config: Parameters<InstanceType<typeof Session>['setConfig']>[0] = {}) {
  const pushes: Push[] = []
  const session = new Session((c, p) => pushes.push([c, p]))
  session.setConfig(config)
  session.open()
  const serial = FakeSerial.last!
  const of = (channel: string) => pushes.filter(([c]) => c === channel).map(([, p]) => p)
  return { session, serial, pushes, of }
}

const HID = async () =>
  ((await import('./hid')) as unknown as { HidReader: { last?: { stopped: boolean } } }).HidReader
    .last!

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
    session.link.connect() // the explicit Connect still works
    expect(FakeSerial.last).toBeDefined()
    session.shutdown()
  })

  it('leaves serial, HID and calibration up when the relay stops', async () => {
    const { session, serial } = launched({ sourceMode: 'bridge' })
    serial.openCb('/dev/fake')
    session.start()
    session.stop()
    expect(serial.stopped).toBe(false)
    expect((await HID()).stopped).toBe(false)
    expect(session.status().device.state).toBe('connected')
    // CalLink is still attached: an exchange is attempted rather than refused as offline.
    const hello = session.link.calHello()
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
      session.start()
      session.stop()
      serial.dataCb(ascii('_NODE_TELEM 030100E02E182EBC02\n'))
      vi.advanceTimersByTime(250)
      expect(of('nodes:telemetry')).toHaveLength(1)
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
      const telem = of('nodes:telemetry').length
      serial.closeCb()
      serial.dataCb(ascii('_NODE_TELEM 030100E02E182EBC02\n')) // a late chunk
      vi.advanceTimersByTime(2000)
      expect(of('nodes:model'), 'no empty model pushed on close').toHaveLength(models)
      expect(of('nodes:telemetry')).toHaveLength(telem)
      session.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets node state on link open, not on relay start (#71 finding 6)', () => {
    const { session, serial } = launched({ sourceMode: 'bridge' })
    const roster = vi.spyOn(session.link.roster, 'reset')
    const nodes = vi.spyOn(session.link.nodes, 'reset')
    serial.openCb('/dev/fake')
    expect(roster).toHaveBeenCalledTimes(1)
    expect(nodes).toHaveBeenCalledTimes(1)
    session.start()
    session.stop()
    session.start()
    expect(roster, 'relay Start must not wipe the roster').toHaveBeenCalledTimes(1)
    expect(nodes, 'relay Start must not wipe the node model').toHaveBeenCalledTimes(1)
    serial.openCb('/dev/fake') // the reconnect
    expect(roster).toHaveBeenCalledTimes(2)
    expect(nodes).toHaveBeenCalledTimes(2)
    session.shutdown()
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
      const logged = of('log:batch').flat() as LogRow[]
      expect(logged.filter((r) => r.dir === 'sys')).toEqual([])
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
    session.link.connect() // Retry
    expect(serial.stopped, 'the failed port is released').toBe(true)
    expect(FakeSerial.last).not.toBe(serial)
    expect(session.status().device.state).toBe('scanning')
    session.shutdown()
  })

  it('ignores connect while the link is already open or looking', () => {
    const { session, serial } = launched()
    session.link.connect()
    expect(FakeSerial.last).toBe(serial)
    serial.openCb('/dev/fake')
    session.link.connect()
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
    off.session.setConfig({ autoConnect: false }) // an open link is left alone
    expect(off.session.status().device.state).toBe('connected')
    off.serial.closeCb()
    expect(off.session.status().device.state).toBe('disconnected')
    expect(off.serial.stopped, 'the port is released, not retried').toBe(true)
    off.session.shutdown()
  })

  it('connects again when auto-connect is turned back on', () => {
    const { session } = launched({ autoConnect: false })
    expect(FakeSerial.last).toBeUndefined()
    session.setConfig({ autoConnect: true })
    expect(FakeSerial.last).toBeDefined()
    expect(session.status().device.state).toBe('scanning')
    session.shutdown()
  })

  it('disconnect releases the serial port until connect, and leaves HID running', async () => {
    const { session, serial } = launched()
    serial.openCb('/dev/fake')
    session.link.disconnect()
    expect(serial.stopped).toBe(true)
    expect((await HID()).stopped, 'HID is shared with DCS and stays up').toBe(false)
    const cal = await session.link.calHello()
    expect(cal.ok ? 'ok' : cal.kind, 'calibration rides on serial').toBe('offline')
    expect(session.status().device.state).toBe('disconnected')
    session.link.connect()
    expect(FakeSerial.last).not.toBe(serial)
    expect(session.status().device.state).toBe('scanning')
    session.shutdown()
  })

  it('reconnects a released link when a Bridge relay starts, and only then', () => {
    const { session, serial } = launched({ sourceMode: 'monitor' })
    session.link.disconnect()
    session.start() // Monitor never uses the board
    expect(FakeSerial.last, 'Monitor leaves the port released').toBe(serial)
    expect(session.status().device.state).toBe('disconnected')
    session.setConfig({ sourceMode: 'bridge' }) // restarts the running relay as Bridge
    expect(FakeSerial.last).not.toBe(serial)
    expect(session.status().device.state).toBe('scanning')
    session.shutdown()
  })

  it('keeps the relay running through a device drop', () => {
    const { session, serial } = launched({ sourceMode: 'bridge' })
    serial.openCb('/dev/fake')
    session.start()
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
    session.start()
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
    session.start()
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
      const logged = of('log:batch').flat() as LogRow[]
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
    session.start()
    const first = FakeTransport.last
    session.setConfig({ autoConnect: false })
    expect(FakeTransport.last, 'toggling auto-connect must not restart the relay').toBe(first)
    session.shutdown()
  })
})

describe('relay state (#69)', () => {
  it('reports the stream separately from the device', () => {
    const { session, of } = launched({ sourceMode: 'bridge' })
    session.start()
    expect(of('relay:state').at(-1)).toEqual({ running: true, stream: 'connecting' })
    FakeTransport.last!.connectedCb(true)
    expect(of('relay:state').at(-1)).toEqual({ running: true, stream: 'connected' })
    FakeTransport.last!.connectedCb(false)
    expect(of('relay:state').at(-1)).toEqual({ running: true, stream: 'reconnecting' })
    session.stop()
    expect(of('relay:state').at(-1)).toEqual({ running: false })
    expect(session.status().relay).toEqual({ running: false })
    expect(session.status().device.state, 'the device knows nothing of the relay').toBe('scanning')
    session.shutdown()
  })
})
