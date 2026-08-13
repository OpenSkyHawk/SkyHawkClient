// SimGateway serial link (main process). Owns the composite device's CDC port —
// the DCS-BIOS byte stream both ways — exactly like the socat relay did. The HID
// interface is a separate device the OS claims; it is handled in M5, not here.
import { SerialPort } from 'serialport'
import { debugLog } from './debug'

export const SIMGATEWAY_VID = 0x2e8a
export const SIMGATEWAY_PID = 0x4134
const VID_HEX = SIMGATEWAY_VID.toString(16).padStart(4, '0')
const PID_HEX = SIMGATEWAY_PID.toString(16).padStart(4, '0')

export type SerialPortInfo = Awaited<ReturnType<typeof SerialPort.list>>[number]

/** Raw enumeration of all serial ports (every PortInfo field) — for the debug dump. */
export function listSerialPorts(): Promise<SerialPortInfo[]> {
  return SerialPort.list()
}

/** USB-CDC ignores baud (virtual), but node-serialport requires a value. */
const BAUD = 250000
const RECONNECT_MS = 2000

/** First serial port whose USB VID/PID match the SimGateway, if present. */
export async function findSimGatewayPort(): Promise<string | undefined> {
  const ports = await SerialPort.list()
  const match = ports.find(
    (p) => p.vendorId?.toLowerCase() === VID_HEX && p.productId?.toLowerCase() === PID_HEX
  )
  return match?.path
}

export interface SerialLink {
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

  private dataCb: (chunk: Buffer) => void = () => {}
  private monitorCb: (dir: 'tx' | 'rx', chunk: Buffer) => void = () => {}
  private errorCb: (err: Error) => void = () => {}
  private openCb: (portPath: string) => void = () => {}
  private closeCb: () => void = () => {}

  constructor(autoReconnect: boolean) {
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
    if (!port) return Promise.resolve()
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

  private async openOnce(): Promise<void> {
    try {
      const path = await findSimGatewayPort()
      if (!path) {
        debugLog('serial.notFound', { vid: VID_HEX, pid: PID_HEX })
        this.errorCb(new Error('SimGateway serial port not found'))
        this.retry()
        return
      }
      this.path = path
      debugLog('serial.open', { path })
      // Awaited, not merely called: `close()` only *begins* the release, and on Windows the OS
      // holds the COM handle until it completes — so opening straight after is the process
      // blocking its own reopen. Measured against real hardware: 24 of 30 reopens failed with
      // "Access denied" without this await, 0 of 30 with it.
      await this.disposePort()
      const port = new SerialPort({ path, baudRate: BAUD, autoOpen: false })
      this.port = port
      port.on('data', (d: Buffer) => {
        this.monitorCb('rx', d)
        this.dataCb(d)
      })
      port.on('error', (e: Error) => {
        debugLog('serial.error', e.message)
        this.errorCb(e)
      })
      port.on('close', () => {
        debugLog('serial.close', { path })
        this.closeCb()
        this.retry()
      })
      // Awaited so `opening` covers the open itself, not merely the call that starts it.
      await new Promise<void>((resolve) => {
        port.open((err) => {
          if (err) {
            debugLog('serial.openError', err.message)
            this.errorCb(err)
            this.retry()
          } else {
            this.openCb(path)
          }
          resolve()
        })
      })
    } catch (err) {
      this.errorCb(err as Error)
      this.retry()
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    // Not awaited — `stop()` is synchronous by interface. Note this leaves one gap: Session
    // discards the bridge on stop and builds a fresh one on start, so a stop/start pair can still
    // open the port while this release is in flight. `retry()` recovers it 2 s later.
    void this.disposePort()
  }

  write(data: Buffer): void {
    if (this.port?.isOpen) this.port.write(data)
    this.monitorCb('tx', data)
  }

  portPath(): string | undefined {
    return this.path
  }
}
