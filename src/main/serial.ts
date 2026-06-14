// SimGateway serial link (main process). Owns the composite device's CDC port —
// the DCS-BIOS byte stream both ways — exactly like the socat relay did. The HID
// interface is a separate device the OS claims; it is handled in M5, not here.
import { SerialPort } from 'serialport'

export const SIMGATEWAY_VID = 0x2e8a
export const SIMGATEWAY_PID = 0x4134
const VID_HEX = SIMGATEWAY_VID.toString(16).padStart(4, '0')
const PID_HEX = SIMGATEWAY_PID.toString(16).padStart(4, '0')

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
  private readonly autoReconnect: boolean

  private dataCb: (chunk: Buffer) => void = () => {}
  private errorCb: (err: Error) => void = () => {}
  private openCb: (portPath: string) => void = () => {}
  private closeCb: () => void = () => {}

  constructor(autoReconnect: boolean) {
    this.autoReconnect = autoReconnect
  }

  onData(cb: (chunk: Buffer) => void): void {
    this.dataCb = cb
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

  private retry(): void {
    if (this.stopped || !this.autoReconnect) return
    this.timer = setTimeout(() => void this.openLoop(), RECONNECT_MS)
  }

  private async openLoop(): Promise<void> {
    try {
      const path = await findSimGatewayPort()
      if (!path) {
        this.errorCb(new Error('SimGateway serial port not found'))
        this.retry()
        return
      }
      this.path = path
      const port = new SerialPort({ path, baudRate: BAUD, autoOpen: false })
      this.port = port
      port.on('data', (d: Buffer) => this.dataCb(d))
      port.on('error', (e: Error) => this.errorCb(e))
      port.on('close', () => {
        this.closeCb()
        this.retry()
      })
      port.open((err) => {
        if (err) {
          this.errorCb(err)
          this.retry()
        } else {
          this.openCb(path)
        }
      })
    } catch (err) {
      this.errorCb(err as Error)
      this.retry()
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.port?.isOpen) this.port.close()
    this.port = undefined
  }

  write(data: Buffer): void {
    if (this.port?.isOpen) this.port.write(data)
  }

  portPath(): string | undefined {
    return this.path
  }
}
