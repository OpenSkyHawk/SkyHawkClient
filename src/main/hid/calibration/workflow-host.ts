// The calibration workflow as the app runs it (R3.1): a CalibrationWorkflow per HID-tab view, the
// dialog's lifetime around it, and the `cal:workflow` push. What the renderer did around its
// controller before the move lives here, in the same order:
//   - useCalibration: the controller's lifetime (built when the HID tab mounts, disposed when it
//     unmounts — now `attach`), the start sequence (open → restore panel → dialog shown), the close
//     sequence (session close → dialog gone → re-read → offer), the restore offer read on mount and
//     on every device report, the link handed to the controller before the report;
//   - the store's rule that the report is dropped whenever the link is not up (store.ts);
//   - where the axis sat when a capture opened (the prompt's direction anchor).
//
// HidCalibrationService hosts one, over its own cal* commands. The component tests' mock hosts one
// over a scripted Gateway, so the dialog under test runs this code.
import type { DeviceState } from '@shared/gateway'
import { isLinkUp } from '../../gateway'
import type {
  CachedBoard,
  CalibrationState,
  CalRawSample,
  CalResult,
  CalSnapshot
} from '@shared/hid/calibration'
import {
  CalibrationWorkflow,
  type CalibrationCommands,
  type WorkflowTimers
} from './calibration-workflow'
import { dialogState, tabState } from './calibration-view-model'

type Offer = { confirmedAt: string; axes: number[] }

/** The HID tab's restore offer from a cache read: the axes the device lost, if any. */
const offerOf = (r: CalResult<{ board?: CachedBoard; regressed: number[] }> | undefined) =>
  r?.ok && r.value.board && r.value.regressed.length
    ? { confirmedAt: r.value.board.confirmedAt, axes: r.value.regressed }
    : undefined

export interface WorkflowHostOptions {
  /** The workflow's clock; the wall clock by default. */
  now?: () => number
  /** Shortest time each write phase stays on screen; 700 ms by default. */
  phaseMinMs?: number
  timers?: WorkflowTimers
}

/**
 * One HID-tab view: what useCalibration held for as long as the tab was mounted — the controller,
 * whether the dialog is shown, the restore offer — plus the dialog's direction anchor.
 */
interface View {
  workflow: CalibrationWorkflow
  /** The commands as this view reaches them; they stop answering once the renderer is gone. */
  commands: CalibrationCommands
  /** The renderer that owned this view was reloaded: nothing it started may continue. */
  gone: boolean
  /** The dialog is on screen: from the end of the start sequence to the end of close's. */
  dialogOpen: boolean
  offer?: Offer
  startRaw: number | null
  /** close() is between the workflow's reset and taking the dialog down. */
  closing: boolean
}

export class CalibrationWorkflowHost {
  /** The HID tab's view while it is mounted (attached); none otherwise. */
  private view?: View
  /** The device's latest report while the link is up (the store's `cal` before R3.1). */
  private snapshot?: CalSnapshot
  private linkUp = false
  /** Answers to a superseded offer read are dropped (the renderer effect's `live` flag). */
  private offerSeq = 0
  private depth = 0
  private dirty = false
  private current: CalibrationState

  constructor(
    private readonly commands: CalibrationCommands,
    private readonly push: (state: CalibrationState) => void,
    private readonly opts: WorkflowHostOptions = {}
  ) {
    this.current = this.derive()
  }

  /** What was last pushed: the `relay:status` rehydrate bundle's calibration. */
  state(): CalibrationState {
    return this.current
  }

  // ── the HID tab's view (`cal:attach`) ──────────────────────────────────────

  /**
   * The HID tab mounted (`true`) or unmounted (`false`): where useCalibration built and disposed
   * its controller.
   *
   * A mount builds a fresh workflow, hands it the link and the report, and reads the restore offer,
   * as the mount's effects did. An unmount disposes it — the ticker and the hold and notice timers
   * stop, RAW is dropped — but, as with the renderer's controller, what was already under way runs
   * on. A mount while a view is still attached means the renderer that owned it was reloaded
   * without unmounting: that view is gone, as the old renderer's controller was.
   */
  attach(on: boolean): void {
    if (this.view) {
      if (on) this.gone(this.view)
      else this.view.workflow.dispose()
      this.view = undefined
      this.offerSeq++
    }
    if (on) this.mount()
    this.publish()
  }

  /**
   * A renderer (re)loaded (`relay:status`, its first pull). A view from before it belonged to the
   * renderer that went away, so it goes with it, as the controller died with the page.
   */
  rendererLoaded(): void {
    if (!this.view) return
    this.gone(this.view)
    this.view = undefined
    this.offerSeq++
    this.publish()
  }

  private mount(): void {
    const life = { gone: false }
    const commands = this.viewCommands(() => life.gone)
    const w = new CalibrationWorkflow(
      commands,
      this.opts.now,
      this.opts.phaseMinMs,
      this.opts.timers
    )
    const v: View = {
      workflow: w,
      commands,
      get gone() {
        return life.gone
      },
      set gone(g: boolean) {
        life.gone = g
      },
      dialogOpen: false,
      startRaw: null,
      closing: false
    }
    this.view = v
    w.subscribe((s) => {
      if (this.view !== v) return
      // close(): the workflow's reset lands one step before the dialog is taken down. Both go out
      // as one push, as the dialog unmounted on the reset's render before.
      if (v.closing && !s.open) {
        this.dirty = true
        return
      }
      this.publish()
    })
    // The mount's effects, in their order: the link, then the report, then the offer.
    this.batch(() => {
      w.linkChanged(this.linkUp)
      w.deviceChanged(this.snapshot)
    })
    void this.refreshOffer()
  }

  /** A dead page's controller never hears back: its calls from here on never answer. */
  private gone(v: View): void {
    v.gone = true
    v.workflow.dispose()
  }

  private viewCommands(gone: () => boolean): CalibrationCommands {
    const c = this.commands
    const call =
      <A extends unknown[], T>(f: (...a: A) => Promise<T>) =>
      (...a: A): Promise<T> =>
        gone() ? new Promise<T>(() => {}) : f(...a)
    return {
      calRead: call(() => c.calRead()),
      calSessionOpen: call((i: number) => c.calSessionOpen(i)),
      calStreamSelect: call((i: number) => c.calStreamSelect(i)),
      calCommit: call((a: Parameters<CalibrationCommands['calCommit']>[0]) => c.calCommit(a)),
      calReset: call((i: number) => c.calReset(i)),
      calSessionClose: call(() => c.calSessionClose()),
      calCacheRead: call(() => c.calCacheRead()),
      calCacheStore: call((a: Parameters<CalibrationCommands['calCacheStore']>[0]) =>
        c.calCacheStore(a)
      ),
      calCacheDrop: call((i: number) => c.calCacheDrop(i))
    }
  }

  // ── what main tells it ─────────────────────────────────────────────────────

  /**
   * The link's state changed (`device:status`).
   *
   * Order matters: the link going down drops the report in the same step, and the workflow must
   * already be paused when that empty report arrives — otherwise it reads as a different board
   * and the captured sweeps are thrown away.
   */
  linkStatus(state: DeviceState): void {
    const up = isLinkUp(state)
    this.batch(() => {
      if (up !== this.linkUp) {
        this.linkUp = up
        this.view?.workflow.linkChanged(up)
        this.publish()
      }
      // Calibration describes the gateway currently attached, so it is only trustworthy while
      // the link is up. Everything else — reconnecting after a close, error, no-device,
      // disconnected — means the snapshot may describe a board that is gone. Clearing only on
      // `no-device` would leave the old board's badges on screen through a reconnect, and if
      // the next board runs firmware predating the calibration protocol it never answers
      // GET_CAL, so they would never be corrected.
      if (!up) this.setSnapshot(undefined)
    })
  }

  /** The device reported its stored calibration (GET_CAL, as calRead reads it). */
  reported(snap: CalSnapshot): void {
    this.setSnapshot(snap)
  }

  /** A batch of RAW samples (`cal:raw`'s batches before R3.1); dropped with no view attached. */
  ingest(samples: CalRawSample[]): void {
    this.view?.workflow.ingest(samples)
  }

  // ── intents (a mounted HID tab's; nothing to act on without one) ───────────

  /** Open the dialog on `axis`; `review` expands the restore offer. */
  async open(axis: number, review = false): Promise<void> {
    const v = this.view
    if (!v) return
    await v.workflow.open(axis, this.snapshot)
    if (this.view !== v) return
    this.batch(() => {
      v.workflow.setRestoreOpen(review)
      // A fresh dialog: its direction anchor starts unset, as the dialog's own ref did.
      v.startRaw = null
      v.dialogOpen = true
      this.publish()
    })
  }

  /** Close the session and the dialog, then re-read what the device holds and the offer. */
  async close(): Promise<void> {
    const v = this.view
    if (!v) return
    v.closing = true
    try {
      await v.workflow.close()
    } finally {
      v.closing = false
    }
    v.dialogOpen = false
    if (this.view === v) this.publish()
    const r = await v.commands.calRead()
    if (r.ok) this.setSnapshot(r.value)
    const c = await v.commands.calCacheRead()
    if (this.view !== v) return
    v.offer = offerOf(c)
    this.publish()
  }

  selectAxis(axis: number): Promise<void> {
    const v = this.view
    return v ? v.workflow.selectAxis(axis) : Promise.resolve()
  }

  startCapture(): void {
    this.view?.workflow.startCapture()
  }

  retry(): void {
    this.view?.workflow.retry()
  }

  setSelfCentring(selfCentring: boolean): void {
    this.view?.workflow.setSelfCentring(selfCentring)
  }

  save(): Promise<void> {
    const v = this.view
    return v ? v.workflow.save() : Promise.resolve()
  }

  restore(): Promise<void> {
    const v = this.view
    return v ? v.workflow.restore() : Promise.resolve()
  }

  deleteAxis(idx: number): Promise<void> {
    const v = this.view
    return v ? v.workflow.deleteAxis(idx) : Promise.resolve()
  }

  setRestoreOpen(open: boolean): void {
    this.view?.workflow.setRestoreOpen(open)
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * A new device report: the view's workflow takes it, then the restore offer is re-read.
   *
   * The offer needs no session: GET_CAL already ran to drive the badges, and the cache is a local
   * file. So it can appear on the HID tab with no dialog open — which is the point, since the user
   * has no reason to open one for an axis they think is calibrated.
   */
  private setSnapshot(next: CalSnapshot | undefined): void {
    if (next === this.snapshot) return
    this.snapshot = next
    const v = this.view
    this.batch(() => {
      v?.workflow.deviceChanged(next)
      this.publish()
    })
    if (v) void this.refreshOffer()
  }

  private async refreshOffer(): Promise<void> {
    const v = this.view!
    const seq = ++this.offerSeq
    const r = await v.commands.calCacheRead()
    if (seq !== this.offerSeq || this.view !== v) return
    v.offer = offerOf(r)
    this.publish()
  }

  /** Changes inside `fn` go out as one push. */
  private batch(fn: () => void): void {
    this.depth++
    try {
      fn()
    } finally {
      this.depth--
    }
    if (this.depth === 0 && this.dirty) this.publish()
  }

  private publish(): void {
    if (this.depth > 0) {
      this.dirty = true
      return
    }
    this.dirty = false
    this.current = this.derive()
    this.push(this.current)
  }

  private derive(): CalibrationState {
    const v = this.view
    const tab = tabState(this.snapshot, this.linkUp, v?.offer)
    if (!v || !v.dialogOpen) return { tab }
    const w = v.workflow
    const s = w.snapshot()
    // Where the axis sat when capture opened — the only honest anchor for "upper"/"lower".
    if (!s.capture) v.startRaw = null
    else if (v.startRaw === null && s.live) v.startRaw = s.live.raw
    return {
      tab,
      dialog: dialogState(s, {
        invalid: w.invalidAxis(),
        selfCentring: w.selfCentring(),
        dirty: w.dirtyAxes(),
        startRaw: v.startRaw
      })
    }
  }
}
