// The serial monitor: the Serial tab's raw view of the Gateway port, both ways. Off unless the tab
// asks (it would otherwise stream the export at full rate); taps GatewayConnection.onTraffic, and
// flushes `serial:traffic` on its own timer on the link's list (LinkRider).
import type { SerialFrame } from '@shared/gateway'
import type { Emit } from '@shared/app'
import type { LinkRider, LinkTimer } from './gateway-connection'

const SERIAL_FLUSH_MS = 50
const MAX_SERIAL_BUF = 4000

export class SerialTrafficMonitor implements LinkRider {
  private serialMonitor = false
  private serialBuf: SerialFrame[] = []
  /**
   * The Serial tab's toggle as the page last set it, which `device:status` carries (R3.3). The
   * page's own: a renderer that (re)loads shows the monitor off while main keeps it running — and
   * its traffic coming — until the toggle is pressed (N1), as when the page held the flag.
   */
  private shownOn = false
  private changed?: () => void

  constructor(private readonly emit: Emit) {}

  /** The page's monitor flag (`device:status`). */
  get shown(): boolean {
    return this.shownOn
  }

  /** Told each time the page's flag is set: GatewayConnection pushes it (AppServices). */
  onShownChange(cb: () => void): void {
    this.changed = cb
  }

  /** A renderer (re)loaded: its flag starts off; the monitor itself keeps running (N1). */
  rendererLoaded(): void {
    this.shownOn = false
  }

  /** The `serial:traffic` flush, on the link's timer list. */
  timers(every: LinkTimer): void {
    every(SERIAL_FLUSH_MS, () => this.flushSerial())
  }

  /** Toggle the raw serial monitor (gated to avoid streaming the export at full rate). */
  setSerialMonitor(on: boolean): void {
    this.serialMonitor = on
    if (!on) this.serialBuf = []
    // The page set its toggle: what it shows comes back on `device:status` (R3.3).
    this.shownOn = on
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
