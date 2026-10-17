// The calibration workflow as the app runs it (R3.1): one CalibrationWorkflow, the dialog's
// lifetime around it, and the `cal:workflow` push. What the renderer did around its controller
// before the move lives here, in the same order:
//   - useCalibration: the start sequence (open → restore panel → dialog shown), the close sequence
//     (session close → dialog gone → re-read → offer), the restore offer re-read on every device
//     report, the link handed to the workflow before the report (CalibrationDialog.tsx);
//   - the store's rule that the report is dropped whenever the link is not up (store.ts);
//   - where the axis sat when a capture opened (the prompt's direction anchor).
//
// HidCalibrationService hosts one, over its own cal* commands. The component tests' mock hosts one
// over a scripted Gateway, so the dialog under test runs this code.
import { isLinkUp, type DeviceState } from '@shared/gateway'
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

export class CalibrationWorkflowHost {
  readonly workflow: CalibrationWorkflow
  /** The dialog is on screen: from the end of the start sequence to the end of close's. */
  private dialogOpen = false
  /** The device's latest report while the link is up (the store's `cal` before R3.1). */
  private snapshot?: CalSnapshot
  private linkUp = false
  private offer?: Offer
  /** Answers to a superseded offer read are dropped (the renderer effect's `live` flag). */
  private offerSeq = 0
  private startRaw: number | null = null
  /** close() is between the workflow's reset and taking the dialog down. */
  private closing = false
  private depth = 0
  private dirty = false
  private current: CalibrationState

  constructor(
    private readonly commands: CalibrationCommands,
    private readonly push: (state: CalibrationState) => void,
    opts: WorkflowHostOptions = {}
  ) {
    this.workflow = new CalibrationWorkflow(commands, opts.now, opts.phaseMinMs, opts.timers)
    // The link is down at launch.
    this.workflow.linkChanged(false)
    this.workflow.subscribe((s) => {
      // close(): the workflow's reset lands one step before the dialog is taken down. Both go out
      // as one push, as the dialog unmounted on the reset's render before.
      if (this.closing && !s.open) {
        this.dirty = true
        return
      }
      this.publish()
    })
    this.current = this.derive()
  }

  /** What was last pushed: the `relay:status` rehydrate bundle's calibration. */
  state(): CalibrationState {
    return this.current
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
        this.workflow.linkChanged(up)
        this.publish()
      }
      // Calibration describes the gateway currently attached, so it is only trustworthy while
      // the link is up. Everything else — reconnecting after a close, error, no-device,
      // disconnected — means the snapshot may describe a board that is gone. Clearing only on
      // `no-device` would leave the old board's badges on screen through a reconnect, and if
      // the next board runs firmware predating the calibration protocol it never sends
      // `cal:data`, so they would never be corrected.
      if (!up) this.setSnapshot(undefined)
    })
  }

  /** The device reported its stored calibration (GET_CAL, as `cal:data` pushes it). */
  reported(snap: CalSnapshot): void {
    this.setSnapshot(snap)
  }

  /** A batch of RAW samples (`cal:raw`'s batches before R3.1). */
  ingest(samples: CalRawSample[]): void {
    this.workflow.ingest(samples)
  }

  /** The cache file was replaced from outside the workflow (a configuration import). */
  cacheChanged(): void {
    void this.refreshOffer()
  }

  // ── intents ────────────────────────────────────────────────────────────────

  /** Open the dialog on `axis`; `review` expands the restore offer. */
  async open(axis: number, review = false): Promise<void> {
    await this.workflow.open(axis, this.snapshot)
    this.batch(() => {
      this.workflow.setRestoreOpen(review)
      this.dialogOpen = true
      this.publish()
    })
  }

  /** Close the session and the dialog, then re-read what the device holds and the offer. */
  async close(): Promise<void> {
    this.closing = true
    try {
      await this.workflow.close()
    } finally {
      this.closing = false
    }
    this.dialogOpen = false
    this.publish()
    const r = await this.commands.calRead()
    if (r.ok) this.setSnapshot(r.value)
    const c = await this.commands.calCacheRead()
    this.offer = offerOf(c)
    this.publish()
  }

  selectAxis(axis: number): Promise<void> {
    return this.workflow.selectAxis(axis)
  }

  startCapture(): void {
    this.workflow.startCapture()
  }

  retry(): void {
    this.workflow.retry()
  }

  setSelfCentring(selfCentring: boolean): void {
    this.workflow.setSelfCentring(selfCentring)
  }

  save(): Promise<void> {
    return this.workflow.save()
  }

  restore(): Promise<void> {
    return this.workflow.restore()
  }

  deleteAxis(idx: number): Promise<void> {
    return this.workflow.deleteAxis(idx)
  }

  setRestoreOpen(open: boolean): void {
    this.workflow.setRestoreOpen(open)
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * A new device report: the workflow takes it, then the restore offer is re-read.
   *
   * The offer needs no session: GET_CAL already ran to drive the badges, and the cache is a local
   * file. So it can appear on the HID tab with no dialog open — which is the point, since the user
   * has no reason to open one for an axis they think is calibrated.
   */
  private setSnapshot(next: CalSnapshot | undefined): void {
    if (next === this.snapshot) return
    this.snapshot = next
    this.batch(() => {
      this.workflow.deviceChanged(next)
      this.publish()
    })
    void this.refreshOffer()
  }

  private async refreshOffer(): Promise<void> {
    const seq = ++this.offerSeq
    const r = await this.commands.calCacheRead()
    if (seq !== this.offerSeq) return
    this.offer = offerOf(r)
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
    const w = this.workflow
    const s = w.snapshot()
    // Where the axis sat when capture opened — the only honest anchor for "upper"/"lower".
    if (!s.capture) this.startRaw = null
    else if (this.startRaw === null && s.live) this.startRaw = s.live.raw
    return {
      tab: tabState(this.snapshot, this.linkUp, this.offer),
      ...(this.dialogOpen && {
        dialog: dialogState(s, {
          invalid: w.invalidAxis(),
          selfCentring: w.selfCentring(),
          dirty: w.dirtyAxes(),
          startRaw: this.startRaw
        })
      })
    }
  }
}
