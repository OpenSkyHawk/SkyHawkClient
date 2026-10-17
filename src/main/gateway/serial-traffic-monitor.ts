// The serial monitor: the Serial tab's raw view of the Gateway port, both ways. Off unless the tab
// asks (it would otherwise stream the export at full rate); taps GatewayConnection.onTraffic, and
// flushes `serial:traffic` on its own timer on the link's list (LinkRider).
import type { SerialFrame } from '@shared/gateway'
import type { Emit } from '@shared/app'
import type { LinkRider, LinkTimer } from './gateway-connection'

const SERIAL_FLUSH_MS = 50
const MAX_SERIAL_BUF = 4000

export class SerialTrafficMonitor implements LinkRider {
  /**
   * The monitor is on: the Serial tab's toggle as it was last set. `device:status` carries it
   * (R3.3), and so does the rehydrate bundle, so a renderer that (re)loads shows the monitor as
   * main runs it (N1).
   */
  private serialMonitor = false
  private serialBuf: SerialFrame[] = []
  private changed?: () => void

  constructor(private readonly emit: Emit) {}

  /** The monitor's flag, as `device:status` carries it. */
  get shown(): boolean {
    return this.serialMonitor
  }

  /** Told each time the flag is set: GatewayConnection pushes it (AppServices). */
  onShownChange(cb: () => void): void {
    this.changed = cb
  }

  /** The `serial:traffic` flush, on the link's timer list. */
  timers(every: LinkTimer): void {
    every(SERIAL_FLUSH_MS, () => this.flushSerial())
  }

  /** Toggle the raw serial monitor (gated to avoid streaming the export at full rate). */
  setSerialMonitor(on: boolean): void {
    this.serialMonitor = on
    if (!on) this.serialBuf = []
    // What the toggle shows comes back on `device:status` (R3.3).
    this.changed?.()
  }

  /** One chunk of port traffic (GatewayConnection.onTraffic). */
  onSerialTraffic(dir: 'tx' | 'rx', chunk: Buffer): void {
    if (!this.serialMonitor) return
    this.serialBuf.push({ t: Date.now(), dir, hex: chunk.toString('hex') })
    if (this.serialBuf.length > MAX_SERIAL_BUF) {
      this.serialBuf.splice(0, this.serialBuf.length - MAX_SERIAL_BUF)
    }
  }

  private flushSerial(): void {
    if (this.serialBuf.length === 0) return
    this.emit('serial:traffic', this.serialBuf.splice(0, MAX_SERIAL_BUF))
  }
}
