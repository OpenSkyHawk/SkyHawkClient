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

  onError(cb: (err: Error) => void): void {
    this.errorCb = cb
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
  }

  snapshot(): HidSnapshot {
    const now = Date.now()
    const dt = Math.max(0.001, (now - this.prevSnapAt) / 1000)
    const rateHz = Math.round((this.reportCount - this.prevCount) / dt)
    this.prevSnapAt = now
    this.prevCount = this.reportCount
    const ageMs = this.lastReportAt ? now - this.lastReportAt : Number.MAX_SAFE_INTEGER
    return { axes: this.axes, buttons: this.buttons, hats: this.hats, ageMs, rateHz }
  }

  stop(): void {
    this.stopped = true
    this.device?.close()
    this.device = undefined
  }
}
