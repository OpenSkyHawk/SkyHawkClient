// SimGateway serial link (main process). Owns the composite device's CDC port —
// the DCS-BIOS byte stream both ways — exactly like the socat relay did. The HID
// interface is a separate device the OS claims; it is handled in M5, not here.
import { SerialPort } from 'serialport'
import { USB_IDENTITY } from '@shared/firmware'

/** Port: the debug log, handed in by app (debug.log lives in app). */
export type Log = (tag: string, data?: unknown) => void

export const SIMGATEWAY_VID = USB_IDENTITY.vid
export const SIMGATEWAY_PID = USB_IDENTITY.pid
// Lower-case, no 0x: the form the OS port list reports, for matching only, never displayed.
// eslint-disable-next-line no-restricted-syntax
const VID_HEX = SIMGATEWAY_VID.toString(16).padStart(4, '0')
// eslint-disable-next-line no-restricted-syntax
const PID_HEX = SIMGATEWAY_PID.toString(16).padStart(4, '0')

export type SerialPortInfo = Awaited<ReturnType<typeof SerialPort.list>>[number]

/** Raw enumeration of all serial ports (every PortInfo field) — for the debug dump. */
export function listSerialPorts(): Promise<SerialPortInfo[]> {
  return SerialPort.list()
}

/**
 * The 1200-baud touch (#173): a port opened at 1200 baud and closed (DTR drops) reboots the
 * Gateway's RP2040 into its UF2 drive. The Adafruit TinyUSB library does it (3.7.7 in firmware
 * 0.3.0's dependencies.txt; SimGateway README.md:218); the firmware defines no constant for it,
 * so the sync can't carry it — it is the library's convention, like the Arduino IDE's.
 */
export const TOUCH_BAUD = 1200

/**
 * Open `path` at TOUCH_BAUD and close it again: the Gateway restarts into its UF2 drive. The
 * caller has released the port first. Rejects when the port won't open.
 */
export async function touchForBootloader(path: string): Promise<void> {
  const port = new SerialPort({ path, baudRate: TOUCH_BAUD, autoOpen: false })
  port.on('error', () => {}) // the board drops off the bus as the port closes
  await new Promise<void>((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())))
  await new Promise<void>((resolve) => {
    try {
      port.close(() => resolve())
    } catch {
      resolve() // already gone with the reboot
    }
  })
}

/** USB-CDC ignores baud (virtual), but node-serialport requires a value. */
const BAUD = USB_IDENTITY.baud
const RECONNECT_MS = 2000

/**
 * No SimGateway is enumerated. Not a fault: it is the normal state of an unplugged board, and the
 * device link reports it as "no device" rather than as an error while it keeps looking.
 */
export class PortNotFoundError extends Error {
  constructor() {
    super('Gateway serial port not found')
    this.name = 'PortNotFoundError'
  }
}

/** First serial port whose USB VID/PID match the SimGateway, if present. */
export async function findSimGatewayPort(): Promise<string | undefined> {
  const ports = await SerialPort.list()
  const match = ports.find(
    (p) => p.vendorId?.toLowerCase() === VID_HEX && p.productId?.toLowerCase() === PID_HEX
  )
  return match?.path
}

interface SerialLink {
  start(): void
  stop(): void
  write(data: Buffer): void
  onData(cb: (chunk: Buffer) => void): void
  onMonitor(cb: (dir: 'tx' | 'rx', chunk: Buffer) => void): void
  onError(cb: (err: Error) => void): void
  onOpen(cb: (portPath: string) => void): void
  onClose(cb: () => void): void
  portPath(): string | undefined
}

export class SerialBridge implements SerialLink {
  private port?: SerialPort
  private path?: string
  private stopped = false
  /** stop()'s release of the port, still in flight or done. */
  private releasing?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  /**
   * An open attempt is in flight.
   *
   * Both the close handler and the open callback can schedule a retry for the same disconnect,
   * and each retry used to build another port. Without this, those overlap and the process ends
   * up holding several handles to a port it is also trying to open.
   */
  private opening = false
  private readonly autoReconnect: boolean
  /**
   * The current "not found" streak has been logged. The link now looks for the board for as long
   * as the app runs, so logging every 2 s retry would bury debug.log in identical lines.
   */
  private notFoundLogged = false

  private dataCb: (chunk: Buffer) => void = () => {}
  private monitorCb: (dir: 'tx' | 'rx', chunk: Buffer) => void = () => {}
  private errorCb: (err: Error) => void = () => {}
  private openCb: (portPath: string) => void = () => {}
  private closeCb: () => void = () => {}

  constructor(
    autoReconnect: boolean,
    private readonly log: Log = () => {}
  ) {
    this.autoReconnect = autoReconnect
  }

  onData(cb: (chunk: Buffer) => void): void {
    this.dataCb = cb
  }
  onMonitor(cb: (dir: 'tx' | 'rx', chunk: Buffer) => void): void {
    this.monitorCb = cb
  }
  onError(cb: (err: Error) => void): void {
    this.errorCb = cb
  }
  onOpen(cb: (portPath: string) => void): void {
    this.openCb = cb
  }
  onClose(cb: () => void): void {
    this.closeCb = cb
  }

  start(): void {
    this.stopped = false
    void this.openLoop()
  }

  /**
   * Schedule one reconnect attempt.
   *
   * At most one: reassigning `timer` does not cancel the timer already pending, so calling this
   * twice for the same disconnect — which the close handler and the open callback both do —
   * previously left two timers running, each building its own port, each leaking another handle.
   */
  private retry(): void {
    if (this.stopped || !this.autoReconnect || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.openLoop()
    }, RECONNECT_MS)
  }

  /**
   * Release a port instance completely.
   *
   * Reassigning `this.port` is not enough. The old instance keeps its data/error/close listeners
   * bound — so its own close still schedules retries — and on Windows it keeps the OS handle,
   * which means **the process blocks its own reopen**. That surfaces as an access-denied error on
   * the very COM port it just lost, and no amount of retrying clears it: only stopping the relay
   * does, because that is what finally releases the handles.
   */
  private disposePort(): Promise<void> {
    const port = this.port
    this.port = undefined
    return port ? this.release(port) : Promise.resolve()
  }

  /** Release one port instance: its listeners unbound, closed if open, then destroyed. */
  private release(port: SerialPort): Promise<void> {
    if (this.port === port) this.port = undefined
    port.removeAllListeners()
    // Re-armed immediately: a late error from the dying handle would otherwise reach a stream with
    // no 'error' listener, which Node escalates to an uncaught exception.
    port.on('error', () => {})
    return new Promise<void>((resolve) => {
      const done = (): void => {
        try {
          port.destroy()
        } catch {
          // Already destroyed by the close itself.
        }
        resolve()
      }
      try {
        if (port.isOpen) port.close(done)
        else done()
      } catch {
        // Already gone with the cable. Nothing left to release.
        resolve()
      }
    })
  }

  private async openLoop(): Promise<void> {
    if (this.opening) return
    this.opening = true
    try {
      await this.openOnce()
    } finally {
      this.opening = false
    }
  }

  /**
   * One attempt to find and open the board. `stopped` is checked again after every await (M4): a
   * bridge stopped while its attempt was in flight goes no further — it opens nothing, reports
   * nothing, and releases a port that finished opening after the stop.
   */
  private async openOnce(): Promise<void> {
    try {
      const path = await findSimGatewayPort()
      if (this.stopped) return
      if (!path) {
        if (!this.notFoundLogged) this.log('serial.notFound', { vid: VID_HEX, pid: PID_HEX })
        this.notFoundLogged = true
        this.errorCb(new PortNotFoundError())
        this.retry()
        return
      }
      this.path = path
      this.notFoundLogged = false
      this.log('serial.open', { path })
      // Awaited, not merely called: `close()` only *begins* the release, and on Windows the OS
      // holds the COM handle until it completes — so opening straight after is the process
      // blocking its own reopen. Measured against real hardware: 24 of 30 reopens failed with
      // "Access denied" without this await, 0 of 30 with it.
      await this.disposePort()
      if (this.stopped) return
      const port = new SerialPort({ path, baudRate: BAUD, autoOpen: false })
      this.port = port
      port.on('data', (d: Buffer) => {
        this.monitorCb('rx', d)
        this.dataCb(d)
      })
      port.on('error', (e: Error) => {
        this.log('serial.error', e.message)
        this.errorCb(e)
      })
      port.on('close', () => {
        this.log('serial.close', { path })
        this.closeCb()
        this.retry()
      })
      // Awaited so `opening` covers the open itself, not merely the call that starts it.
      await new Promise<void>((resolve) => {
        port.open((err) => {
          if (this.stopped) {
            // Stopped mid-open: stop() released `this.port`, but this handle may have opened
            // after it. Release it here so the port is not held until quit.
            if (!err) void this.release(port)
          } else if (err) {
            this.log('serial.openError', err.message)
            this.errorCb(err)
            this.retry()
          } else {
            this.openCb(path)
          }
          resolve()
        })
      })
    } catch (err) {
      if (this.stopped) return
      this.errorCb(err as Error)
      this.retry()
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    // Not awaited — `stop()` is synchronous by interface. Note this leaves one gap: the device link
    // discards the bridge on disconnect and builds a fresh one on connect, so a quick
    // disconnect/connect pair can still open the port while this release is in flight. `retry()`
    // recovers it 2 s later.
    this.releasing = this.disposePort()
  }

  /** After stop(): resolves once the port is released, before anything else opens it (#173). */
  whenReleased(): Promise<void> {
    return this.releasing ?? Promise.resolve()
  }

  write(data: Buffer): void {
    if (this.port?.isOpen) this.port.write(data)
    this.monitorCb('tx', data)
  }

  portPath(): string | undefined {
    return this.path
  }
}
