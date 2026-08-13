// Reads the SimGateway HID interface in parallel with DCS (which keeps using it
// as a joystick) and decodes the 34-byte report.
//
// node-hid is an optional, lazily loaded dependency, and the two ways it can fail need opposite
// treatment. **The module being absent is permanent** — it will not appear while the app runs, so
// giving up is right. **The device being absent is not**: it comes back when the cable is
// replugged, and treating that like a missing dependency left HID dead until the user stopped and
// restarted the relay, while serial recovered on its own and made everything look healthy.
import {
  decodeReport,
  HID_AXIS_COUNT,
  HID_BUTTON_COUNT,
  HID_HAT_COUNT,
  HID_REPORT_SIZE
} from '@shared/hid'
import type { HidSnapshot } from '@shared/ipc'
import { SIMGATEWAY_PID, SIMGATEWAY_VID } from './serial'

/** Matches the serial link's reconnect cadence — the same cable, coming back at the same time. */
const RECONNECT_MS = 2000

// Minimal structural types — we deliberately avoid a static node-hid import so
// neither typecheck nor `npm ci` depends on the optional native module.
interface NodeHidDevice {
  on(event: 'data', cb: (data: Buffer) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  /**
   * Asynchronous, and the promise matters: it resolves once node-hid has stopped its read thread
   * and released the threadsafe function that thread calls into. Declaring this `void` is what let
   * the teardown be fired and forgotten.
   */
  close(): Promise<void>
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
  private timer?: ReturnType<typeof setTimeout>
  /** node-hid itself could not be loaded. Permanent — never retried. */
  private unavailable = false
  /**
   * An open is in flight.
   *
   * The first serial open fires the same callback a reconnect does, so `reopen()` can arrive
   * while `start()`'s open is still awaiting node-hid. Without this guard both would complete,
   * the second handle would overwrite the first, and the orphan would go on emitting reports
   * into a reader that no longer knows it exists.
   */
  private opening = false
  /**
   * When we began listening.
   *
   * Used as the age baseline until the first report arrives. Reporting an infinite age would be
   * literally true and practically wrong: the device sends only on change, so an idle stick has
   * sent nothing a second after connecting, and a freshness readout would call that stale. What
   * the user actually wants to know is how long we have been listening without hearing anything.
   */
  private listeningSince = 0
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
    this.listeningSince = Date.now()
    void this.open()
  }

  /**
   * Drop any handle and open again.
   *
   * Called when the serial port reopens, because both interfaces belong to the same physical
   * device: a serial reconnect is proof the USB device re-enumerated, and the handle we hold is
   * stale whether or not node-hid ever told us so. That matters because a disconnect does not
   * reliably surface as an error event on every platform, so waiting to be told can wait forever.
   */
  reopen(): void {
    if (this.stopped || this.unavailable || this.opening) return
    this.clearTimer()
    // Sequenced, not fired together: the old handle must be fully released before the next open,
    // or the two overlap in node-hid's native layer. On Windows the serial port re-enumerates
    // ahead of the HID interface, so this reopen frequently lands while the device is still
    // settling — the open below may fail, and `retry()` is what covers that.
    void this.closeDevice().then(() => {
      if (this.stopped || this.unavailable) return
      this.listeningSince = Date.now()
      void this.open()
    })
  }

  private async open(): Promise<void> {
    if (this.opening) return
    this.opening = true
    try {
      await this.openOnce()
    } finally {
      this.opening = false
    }
  }

  private async openOnce(): Promise<void> {
    let mod: NodeHidModule
    try {
      // Non-literal specifier: typecheck stays independent of the optional module,
      // and the bundler leaves it as a runtime require (resolved from node_modules).
      const spec = 'node-hid'
      mod = (await import(/* @vite-ignore */ spec)) as unknown as NodeHidModule
    } catch (err) {
      // The optional dependency is not installed. Nothing will change that at runtime.
      this.unavailable = true
      this.errorCb(err as Error)
      return
    }

    try {
      const dev = await mod.HIDAsync.open(SIMGATEWAY_VID, SIMGATEWAY_PID)
      if (this.stopped) {
        await dev.close()
        return
      }
      this.device = dev
      dev.on('data', (buf) => this.onData(buf))
      dev.on('error', (err) => this.lost(err))
    } catch (err) {
      // No device on this VID/PID yet. It may be plugged in later, or still settling after a
      // replug, so keep trying rather than staying idle for the life of the session.
      this.errorCb(err as Error)
      this.retry()
    }
  }

  /**
   * The handle died under us. Release it and start trying again.
   *
   * The release is deferred off this tick because this runs *inside* node-hid's own error
   * callback: closing from within it frees the threadsafe function while the native read thread
   * is still delivering through it, which aborts the process rather than throwing. Observed on
   * Windows during a replug — one abort in three unplug cycles.
   *
   * The retry is chained after the close rather than scheduled beside it, so an open can never
   * begin while the previous handle is still unwinding.
   */
  private lost(err: Error): void {
    this.errorCb(err)
    setImmediate(() => {
      void this.closeDevice().then(() => this.retry())
    })
  }

  private retry(): void {
    if (this.stopped || this.unavailable || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.open()
    }, RECONNECT_MS)
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /**
   * Release the handle and wait for node-hid to finish tearing it down.
   *
   * The wait is the point. `close()` returns a promise that settles once the native read thread
   * has stopped; dropping it meant the next open could begin while that thread was still running
   * against a threadsafe function the teardown had already freed. That is an abort inside node-hid
   * (`Assertion failed: (func) != nullptr`), not an exception — nothing here can catch it.
   */
  private async closeDevice(): Promise<void> {
    const dev = this.device
    this.device = undefined
    if (!dev) return
    try {
      await dev.close()
    } catch {
      // Already gone with the cable; nothing to release.
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
    const since = this.lastReportAt || this.listeningSince
    const ageMs = since ? Date.now() - since : Number.MAX_SAFE_INTEGER
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
    this.clearTimer()
    // Not awaited — `stop()` is synchronous by interface. `stopped` already bars any further open,
    // so the teardown has no reopen to race against.
    void this.closeDevice()
  }
}
