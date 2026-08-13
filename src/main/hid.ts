// Reads the SimGateway HID interface in parallel with DCS (which keeps using it
// as a joystick) and decodes the 34-byte report. node-hid is an optional, lazily
// loaded dependency: if it is absent or the device is unplugged, HID simply stays
// idle — the rest of the app is unaffected.
import {
  decodeReport,
  HID_AXIS_COUNT,
  HID_BUTTON_COUNT,
  HID_HAT_COUNT,
  HID_REPORT_SIZE
} from '@shared/hid'
import type { HidSnapshot } from '@shared/ipc'
import { SIMGATEWAY_PID, SIMGATEWAY_VID } from './serial'

// Minimal structural types — we deliberately avoid a static node-hid import so
// neither typecheck nor `npm ci` depends on the optional native module.
interface NodeHidDevice {
  on(event: 'data', cb: (data: Buffer) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  close(): void
}
interface NodeHidModule {
  HIDAsync: { open(vid: number, pid: number): Promise<NodeHidDevice> }
}

export class HidReader {
  private device?: NodeHidDevice
  private stopped = false
  private errorCb: (err: Error) => void = () => {}

  private axes: number[] = Array(HID_AXIS_COUNT).fill(0)
  private buttons: boolean[] = Array(HID_BUTTON_COUNT).fill(false)
  private hats: number[] = Array(HID_HAT_COUNT).fill(0)
  private lastReportAt = 0
  private reportCount = 0
  private prevSnapAt = Date.now()
  private prevCount = 0
  private rateHz = 0
  private reportCb: () => void = () => {}

  onError(cb: (err: Error) => void): void {
    this.errorCb = cb
  }

  /**
   * Called on every arriving report.
   *
   * The device sends only on change, so this fires exactly when something moved — which is the
   * only moment the UI has anything new to show. Polling a snapshot on a timer instead adds the
   * whole interval to the latency of every press, and drops any press-and-release that lands
   * between two polls: a snapshot is a level, not an event.
   */
  onReport(cb: () => void): void {
    this.reportCb = cb
  }

  start(): void {
    this.stopped = false
    void this.open()
  }

  private async open(): Promise<void> {
    try {
      // Non-literal specifier: typecheck stays independent of the optional module,
      // and the bundler leaves it as a runtime require (resolved from node_modules).
      const spec = 'node-hid'
      const mod = (await import(/* @vite-ignore */ spec)) as unknown as NodeHidModule
      const dev = await mod.HIDAsync.open(SIMGATEWAY_VID, SIMGATEWAY_PID)
      if (this.stopped) {
        dev.close()
        return
      }
      this.device = dev
      dev.on('data', (buf) => this.onData(buf))
      dev.on('error', (err) => this.errorCb(err))
    } catch (err) {
      // node-hid missing, or no HID device present — stay idle.
      this.errorCb(err as Error)
    }
  }

  private onData(buf: Buffer): void {
    if (buf.length < HID_REPORT_SIZE) return
    const { axes, buttons, hats } = decodeReport(buf)
    this.axes = axes
    this.buttons = buttons
    this.hats = hats
    this.lastReportAt = Date.now()
    this.reportCount++
    this.reportCb()
  }

  /**
   * The current state. Free of side effects, so it can be called as often as reports arrive.
   *
   * The rate deliberately is not computed here. It was, and that silently tied its accuracy to
   * how often the caller happened to ask: sampling every 16 ms turns one report into "60 Hz".
   * `sampleRate()` owns the window instead.
   */
  snapshot(): HidSnapshot {
    const ageMs = this.lastReportAt ? Date.now() - this.lastReportAt : Number.MAX_SAFE_INTEGER
    return { axes: this.axes, buttons: this.buttons, hats: this.hats, ageMs, rateHz: this.rateHz }
  }

  /** Close the reporting-rate window. Call on a fixed interval — the rate is per that window. */
  sampleRate(): void {
    const now = Date.now()
    const dt = Math.max(0.001, (now - this.prevSnapAt) / 1000)
    this.rateHz = Math.round((this.reportCount - this.prevCount) / dt)
    this.prevSnapAt = now
    this.prevCount = this.reportCount
  }

  stop(): void {
    this.stopped = true
    this.device?.close()
    this.device = undefined
  }
}
