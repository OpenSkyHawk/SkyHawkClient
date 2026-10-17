// The SimGateway's HID joystick, as the app runs it (its own service since R2.2a): the reader's
// lifecycle, the throttled push to the renderer, the rate window, and the reopen when the serial
// port comes back. It rides on the Gateway connection (gateway LinkRider) for those moments; its
// I/O is the HID reader.
import type { Emit } from '@shared/app'
import type { HidReport } from '@shared/hid'
import type { CalSnapshot } from '@shared/hid/calibration'
import type { LinkRider, LinkTimer } from '../gateway'
import { hidFacts } from './hid-facts'
import { HidReader } from './hid-reader'
import { hidAvailability } from './hid-report'

/** Port: the debug log, handed in by app (debug.log lives in app). */
export type Log = (tag: string, data?: unknown) => void

/**
 * Shortest gap between HID pushes to the renderer.
 *
 * A press used to wait for the 200 ms telemetry tick, which is visible lag on a button and
 * enough to lose a quick tap entirely. Reports now drive the push, capped here at roughly one
 * frame so a fast axis sweep — the device can emit a few hundred a second — cannot flood IPC.
 */
const HID_PUSH_MS = 16
const HID_RATE_MS = 1000

export class HidService implements LinkRider {
  private hid?: HidReader
  private hidPushedAt = 0
  private hidPushTimer?: ReturnType<typeof setTimeout>
  /** What the device declares, as the HID tab last had it from calibration (`cal:workflow`). */
  private calSnapshot?: CalSnapshot
  /** What HIDControls.h catalogues: the report indices the tab can show (fixed per build). */
  private readonly catalogued = hidAvailability().axes

  constructor(
    private readonly emit: Emit,
    private readonly log: Log
  ) {}

  /** The rate window, on the link's timer list. */
  timers(every: LinkTimer): void {
    every(HID_RATE_MS, () => this.hid?.sampleRate())
  }

  /**
   * HID is read, never claimed: DCS reads the same interface as a joystick, so it runs for as long
   * as the app does — independent of the serial port, and still up while the port is released.
   * It reconnects on its own, so its errors are worth recording rather than swallowing — they are
   * how we learn whether an unplug surfaces here at all, or only as the serial port dropping.
   */
  start(): void {
    const h = new HidReader()
    this.hid = h
    h.onError((err) => this.log('hid.error', { message: err.message }))
    h.onReport(() => this.pushHid())
    h.start()
  }

  /**
   * Same physical device, so the port reopening is proof it re-enumerated and any HID handle
   * we hold is stale. This is the reliable trigger: a disconnect does not surface as a
   * node-hid error event on every platform, and serial recovery is proven.
   */
  opened(): void {
    this.hid?.reopen()
  }

  /**
   * The link's push tick. Still emitted while nothing is arriving: a silent device is the normal
   * resting state, and ageMs and the rate have to keep moving for the UI to say so.
   */
  flush(): void {
    if (this.hid) this.emit('hid:report', this.report(this.hid))
  }

  /**
   * Calibration pushed what the device declares (`cal:workflow`, AppServices): the live axes
   * follow it now rather than at the next report, as the tab re-rendered on that push (R3.3).
   */
  calibrationChanged(snapshot: CalSnapshot | undefined): void {
    if (snapshot === this.calSnapshot) return
    this.calSnapshot = snapshot
    this.flush()
  }

  /**
   * A renderer (re)loaded (`relay:status`): it gets the report and its live axes now, as it had
   * its catalogue from its first pull, rather than at the next tick (R3.3).
   */
  rendererLoaded(): void {
    this.flush()
  }

  /** The reader's snapshot and what it means for the HID tab (hid-facts.ts). */
  private report(hid: HidReader): HidReport {
    const snap = hid.snapshot()
    return { ...snap, ...hidFacts(snap.ageMs, this.calSnapshot, this.catalogued) }
  }

  /** App quit. */
  stop(): void {
    if (this.hidPushTimer) clearTimeout(this.hidPushTimer)
    this.hidPushTimer = undefined
    this.hid?.stop()
    this.hid = undefined
  }

  /**
   * Push HID state, at most once per `HID_PUSH_MS`.
   *
   * Leading edge so a press shows immediately, trailing edge so the state that follows it is
   * never the one left unsent — which is what stops a press-and-release inside one window from
   * disappearing. Both halves are needed: leading alone loses the release, trailing alone adds
   * the delay back.
   */
  private pushHid(): void {
    if (!this.hid) return
    const now = Date.now()
    const since = now - this.hidPushedAt
    if (since >= HID_PUSH_MS) {
      this.hidPushedAt = now
      this.emit('hid:report', this.report(this.hid))
      return
    }
    if (this.hidPushTimer) return
    this.hidPushTimer = setTimeout(() => {
      this.hidPushTimer = undefined
      if (!this.hid) return
      this.hidPushedAt = Date.now()
      this.emit('hid:report', this.report(this.hid))
    }, HID_PUSH_MS - since)
  }
}
