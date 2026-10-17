// Orchestration for the calibration dialog: session lifecycle, sample routing, and the write
// sequence. Everything the dialog needs to *decide* lives here; the dialog renders and calls in.
// (Was the renderer's CalibrationController until R3.1; HidCalibrationService hosts it now.)
//
// Depends on injected commands and timers rather than the service and the clock directly, so the
// whole flow is testable without Electron or a device.
import {
  beginCapture,
  midpoint,
  push as pushSample,
  restartSweep,
  retrySweep,
  tick
} from './axis-capture'
import type {
  CachedBoard,
  CalCacheEntry,
  CalCommitAxis,
  CalFailure,
  CalRawSample,
  CalResult,
  CalSnapshot,
  CaptureState,
  WorkflowState
} from '@shared/hid/calibration'

/**
 * The calibration exchanges the workflow sequences: HidCalibrationService's own cal* commands,
 * called directly. Narrower than the service, and trivial to fake.
 */
export interface CalibrationCommands {
  calRead(): Promise<CalResult<CalSnapshot>>
  calSessionOpen(axisIdx: number): Promise<CalResult<{ timeoutMs: number; axisIdx: number }>>
  calStreamSelect(axisIdx: number): Promise<CalResult<null>>
  calCommit(axis: CalCommitAxis): Promise<CalResult<null>>
  calReset(idx: number): Promise<CalResult<null>>
  calSessionClose(): Promise<CalResult<null>>
  calCacheRead(): Promise<CalResult<{ board?: CachedBoard; regressed: number[] }>>
  calCacheStore(axes: CalCacheEntry[]): Promise<CalResult<null>>
  calCacheDrop(idx: number): Promise<CalResult<null>>
}

/** setTimeout / setInterval and their clears: the wall clock unless a test drives its own. */
export interface WorkflowTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(id: unknown): void
}

/** The global timers, looked up at each call so a test's fake timers apply. */
export const SYSTEM_TIMERS: WorkflowTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>)
}

const emptyState = (): WorkflowState => ({
  open: false,
  axis: 0,
  drafts: {},
  restPosition: {},
  streaming: false,
  restoreOpen: false,
  paused: false,
  busy: false
})

/**
 * Cheap identity for a device, so a stale snapshot is never shown against a different board.
 * VID/PID are identical across every gateway, so the serial is the only distinguishing field.
 */
const boardOf = (s?: CalSnapshot) => s?.serialNumber ?? null

export class CalibrationWorkflow {
  private state = emptyState()
  private listeners = new Set<(s: WorkflowState) => void>()
  private ticker?: unknown
  private holdTimer?: unknown
  private noticeTimer?: unknown
  /** The serial link as last reported, kept outside `state` so it survives open() resetting it. */
  private linkUp = true
  private resuming = false
  /**
   * The cache has not been read for this dialog yet — opened while the link was down, the link
   * dropped during the open handshake, or a different board came back. The next resume reads it.
   */
  private seedOnResume = false
  /**
   * The failure a session open reported, kept by identity so a later successful reopen can take
   * it down. Any other failure — a write, a delete — replaces the object and so is left showing.
   */
  private sessionFailure?: WorkflowState['failure']

  constructor(
    private readonly api: CalibrationCommands,
    /** Injected so tests can drive time; defaults to the wall clock. */
    private readonly now: () => number = () => Date.now(),
    /**
     * Shortest time each write phase stays on screen.
     *
     * A COMMIT is a few tens of milliseconds and the read-back little more, so without a floor
     * the per-axis messages — which name the axis being written — are gone before they can be
     * read, and a multi-axis write looks like a single flash. This trades total time for
     * legibility: each axis costs two phases, so a queue of N axes spends 2 × N × this padding.
     *
     * Tests pass 0. The delay is deliberately not part of what they assert, and paying it on
     * every save would make the suite slow for nothing.
     */
    private readonly phaseMinMs: number = 700,
    /** Injected so tests (and the component tests' mock) can drive time. */
    private readonly timers: WorkflowTimers = SYSTEM_TIMERS
  ) {}

  /** Run something, then wait out whatever is left of the minimum display time. */
  private async atLeast<T>(fn: () => Promise<T>): Promise<T> {
    const started = this.now()
    const result = await fn()
    const left = this.phaseMinMs - (this.now() - started)
    if (left > 0) await new Promise<void>((r) => this.timers.setTimeout(r, left))
    return result
  }

  subscribe(fn: (s: WorkflowState) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  snapshot(): WorkflowState {
    return this.state
  }

  private set(patch: Partial<WorkflowState>): void {
    this.state = { ...this.state, ...patch }
    for (const fn of this.listeners) fn(this.state)
  }

  // ── session ────────────────────────────────────────────────────────────────

  /**
   * Open the dialog on one axis.
   *
   * The session is only considered open once SESSION_ACK arrives. A bad index is refused with
   * BAD_INDEX and leaves the device's session closed, so assuming success from having sent the
   * request would leave us believing in a session the device does not have.
   */
  async open(axis: number, device?: CalSnapshot): Promise<void> {
    if (!this.linkUp) {
      // The link closed between the click and here. Open paused; the session opens on resume.
      this.set({ ...emptyState(), open: true, axis, device, paused: true })
      this.seedOnResume = true
      return
    }
    // Cleared only once the cache has actually been read: if the link drops during the
    // handshake, the open fails and the resume that follows has to do the seeding instead.
    this.seedOnResume = true
    this.set({ ...emptyState(), open: true, axis, device, busy: true })
    const r = await this.api.calSessionOpen(axis)
    if (!r.ok) {
      this.sessionFailure = { ...r, axis }
      this.set({ busy: false, failure: this.sessionFailure })
      return
    }
    await this.seedFromCache()
    this.seedOnResume = false
    this.set({ busy: false, failure: undefined })
    this.startTicking()
  }

  /** Rest positions and the restore offer, from the local cache. Run once per dialog. */
  private async seedFromCache(): Promise<void> {
    // The rest position is part of the calibration, but the device has no field for it — there is
    // deliberately no axis type in the blob. So it comes back from the cache, or every axis would
    // silently revert to the self-centring default and a throttle would be asked to release to a
    // rest position it does not have.
    const cache = await this.api.calCacheRead()
    const restPosition = { ...this.state.restPosition }
    let restorable: WorkflowState['restorable']
    if (cache.ok && cache.value.board) {
      for (const [key, a] of Object.entries(cache.value.board.axes)) {
        restPosition[Number(key)] = a.selfCentring
      }
      if (cache.value.regressed.length > 0) {
        restorable = { board: cache.value.board, axes: cache.value.regressed }
      }
    }
    this.set({ restPosition, restorable })
  }

  /**
   * Switch the axis on screen, and the one the device streams.
   *
   * Drafts are keyed by axis and deliberately survive this — #46 requires edits to persist when
   * moving along the rail, and they are written together at the end.
   */
  async selectAxis(axis: number): Promise<void> {
    if (axis === this.state.axis || this.state.switchingTo === axis) return
    if (this.state.paused) {
      // Nothing to tell the device: the session reopens on whichever axis is on screen when the
      // link returns. Switching still works so drafts can be reviewed while waiting.
      this.set({ axis, streaming: false, capture: undefined, live: undefined })
      return
    }
    this.set({ switchingTo: axis, busy: true, failure: undefined })

    const r = await this.api.calStreamSelect(axis)
    if (!r.ok) {
      // Stay where we were. The gateway is still streaming the previous axis, so pretending
      // otherwise would drop every sample on `idx` and leave a retry unable to fire.
      this.set({ switchingTo: undefined, busy: false, failure: { ...r, axis } })
      return
    }
    this.set({
      axis,
      switchingTo: undefined,
      busy: false,
      streaming: false,
      capture: undefined,
      live: undefined
    })
  }

  async close(): Promise<void> {
    this.stopTicking()
    await this.api.calSessionClose()
    this.set({ ...emptyState(), paused: !this.linkUp })
  }

  // ── sampling ───────────────────────────────────────────────────────────────

  /**
   * Feed a batch of RAW samples.
   *
   * Samples for other axes are dropped rather than fed to the capture: a frame can be in flight
   * across a STREAM_SELECT, and RAW carries `idx` precisely so it can be discarded.
   */
  ingest(samples: CalRawSample[]): void {
    // A batch flushed after the close predates it, and the capture it would feed is frozen.
    if (this.state.paused) return
    let capture = this.state.capture
    let live = this.state.live
    for (const s of samples) {
      if (s.idx !== this.state.axis) continue
      live = { raw: s.raw, cal: s.cal }
      if (capture) capture = pushSample(capture, { t: s.t, raw: s.raw })
    }
    // Reaching here means a sample matched `axis` — the `continue` above filters the rest — so
    // this is the proof that data is flowing for the selected axis. A frame for the axis we just
    // left never gets this far, and so never counts as confirmation.
    if (capture !== this.state.capture || live !== this.state.live) {
      this.advanceCapture(capture, { live, streaming: true })
    }
  }

  /**
   * Recompute the offer from the cache and the device's latest report.
   *
   * Runs after every write, not only after a restore. An axis can leave the regressed set two
   * ways — restored from the cache, or simply recalibrated by hand — and in both cases the device
   * now holds it, so continuing to offer a copy invites the user to overwrite good data with
   * older numbers.
   */
  private async refreshOffer(): Promise<void> {
    const cache = await this.api.calCacheRead()
    this.set({
      restorable:
        cache.ok && cache.value.board && cache.value.regressed.length
          ? { board: cache.value.board, axes: cache.value.regressed }
          : undefined
    })
  }

  /** Show or hide the restore offer. Reviewing is deliberately a separate step from restoring. */
  setRestoreOpen(restoreOpen: boolean): void {
    this.set({ restoreOpen })
  }

  /**
   * Write the cached copy back, for the axes the device has lost.
   *
   * Nothing new on the wire — this seeds drafts from the cache and runs the ordinary save, so it
   * inherits the read-back verification, the failure paths, and the re-cache. A restore that
   * half-lands is therefore reported the same way a half-landed save is.
   *
   * Only regressed axes are queued. An axis the device still holds is not replaced: the device's
   * copy is the authority, and the cache exists to fill a gap, not to overrule one.
   */
  async restore(): Promise<void> {
    const r = this.state.restorable
    if (!r || this.state.write || this.state.paused) return
    // `restPosition` is not touched here: open() seeded it from this same cache entry, and
    // restore() cannot run before open().
    const drafts = { ...this.state.drafts }
    for (const idx of r.axes) {
      const a = r.board.axes[idx]
      if (!a) continue
      drafts[idx] = {
        min: a.min,
        centre: a.centre,
        max: a.max,
        selfCentring: a.selfCentring,
        capturedCentre: a.selfCentring ? a.centre : undefined
      }
    }
    this.set({ drafts, restoreOpen: false, failure: undefined })
    await this.save()
  }

  /** Begin capturing the axis on screen, honouring its rest-position setting. */
  startCapture(): void {
    if (this.state.paused) return
    this.set({
      capture: beginCapture(this.now(), this.selfCentring()),
      failure: undefined
    })
  }

  /** Acknowledge a rejected sweep and redo it, keeping the accepted ones. */
  retry(): void {
    if (this.state.paused) return
    if (this.state.capture) this.set({ capture: retrySweep(this.state.capture, this.now()) })
  }

  /**
   * Advance the stability detector without a sample.
   *
   * Not optional: a held axis emits nothing, so a hold evaluated only on arrival would never
   * complete. Runs while the dialog is open and stops with it.
   */
  private startTicking(): void {
    this.stopTicking()
    this.ticker = this.timers.setInterval(() => {
      const c = this.state.capture
      if (!c || c.phase !== 'capturing' || this.state.paused) return
      const next = tick(c, this.now())
      if (next !== c) this.advanceCapture(next)
    }, 100)
  }

  private stopTicking(): void {
    if (this.ticker) this.timers.clearInterval(this.ticker)
    this.ticker = undefined
  }

  /**
   * Commit a new capture state, banking the draft the moment it completes.
   *
   * **Both completion paths must come through here.** A hold commits either from the ticker (the
   * axis went silent, which is the common case at a mechanical stop) or from inside `push` when
   * an arriving sample happens to be the one that satisfies the dwell. Banking only in the
   * ticker leaves the sample-completed capture stranded: `phase` is `complete`, so the ticker
   * returns on its own guard, no draft is ever created, and the Write button greys out on a
   * capture the user just finished. That was intermittent by construction — the same axis
   * completes down either path depending on when the last sample lands.
   */
  private advanceCapture(capture: CaptureState | undefined, extra: Partial<WorkflowState> = {}) {
    if (capture?.phase === 'complete' && capture.result) {
      this.set({
        ...extra,
        capture: undefined,
        drafts: {
          ...this.state.drafts,
          [this.state.axis]: {
            ...capture.result,
            selfCentring: capture.selfCentring,
            capturedCentre: capture.selfCentring ? capture.result.centre : undefined
          }
        }
      })
      return
    }
    this.set({ ...extra, capture })
  }

  /** Whether the axis on screen is set to return to rest. Defaults true for every axis. */
  selfCentring(axis = this.state.axis): boolean {
    return this.state.restPosition[axis] ?? true
  }

  /**
   * Change the rest-position setting for the axis on screen.
   *
   * Works before a capture as well as after — that is the point, since the setting decides
   * whether the capture has a centre step. When a draft already exists its centre is re-derived
   * from `capturedCentre`, so the switch is a view of the capture rather than an edit to it and
   * toggling back restores the measured rest position exactly.
   */
  setSelfCentring(selfCentring: boolean): void {
    const axis = this.state.axis
    const restPosition = { ...this.state.restPosition, [axis]: selfCentring }
    const d = this.state.drafts[axis]
    if (!d) {
      this.set({ restPosition })
      return
    }
    // Derived from the toggle, never written over the measurement — so this is a view of the
    // same capture and flipping back and forth costs nothing.
    const centre = selfCentring ? (d.capturedCentre ?? d.centre) : midpoint(d.min, d.max)
    this.set({
      restPosition,
      drafts: { ...this.state.drafts, [axis]: { ...d, selfCentring, centre } }
    })
  }

  // ── writing ────────────────────────────────────────────────────────────────

  /** Axes with edits, in index order. Only these are written. */
  dirtyAxes(): number[] {
    return Object.keys(this.state.drafts)
      .map(Number)
      .sort((a, b) => a - b)
  }

  /**
   * An axis the device would refuse, and why — so the UI can say which one blocks the write
   * rather than greying a button with no explanation.
   */
  invalidAxis(): { axis: number; reason: string } | null {
    for (const idx of this.dirtyAxes()) {
      const d = this.state.drafts[idx]!
      if (!(d.min < d.centre && d.centre < d.max)) {
        return { axis: idx, reason: 'centre must fall between min and max' }
      }
    }
    return null
  }

  /**
   * Write every edited axis, one COMMIT each, verifying after each.
   *
   * Per-axis rather than batched: a client that dies part-way leaves the finished axes stored,
   * and `calibratedMask` reports exactly which. A failure stops the queue but keeps whatever
   * already stored — that partial success is worth naming in the UI rather than implying.
   */
  async save(): Promise<void> {
    const queue = this.dirtyAxes()
    if (!queue.length || this.state.write || this.state.paused) return

    this.set({ write: { phase: 'writing', queue, at: 0, stored: [] }, failure: undefined })
    const stored: number[] = []

    for (let at = 0; at < queue.length; at++) {
      const idx = queue[at]!
      const d = this.state.drafts[idx]!
      this.set({ write: { phase: 'writing', queue, at, stored: [...stored] } })

      const commit = await this.atLeast(() =>
        this.api.calCommit({ idx, min: d.min, centre: d.centre, max: d.max })
      )
      if (!commit.ok) {
        await this.failWrite(commit, idx, stored)
        return
      }

      // The ACK said "received". Only the read-back says "stored".
      this.set({ write: { phase: 'verifying', queue, at, stored: [...stored] } })
      const read = await this.atLeast(() => this.api.calRead())
      if (!read.ok) {
        await this.failWrite(read, idx, stored)
        return
      }

      const axis = read.value.axes[idx]
      if (
        !axis?.calibrated ||
        axis.min !== d.min ||
        axis.centre !== d.centre ||
        axis.max !== d.max
      ) {
        await this.failWrite(
          {
            kind: 'error',
            message: 'The device acknowledged the write but read back different values.'
          },
          idx,
          stored
        )
        return
      }

      stored.push(idx)
      // The device has confirmed these exact values, so this is the moment they are worth
      // keeping — after the read-back, never after the ACK. Reading them off `axis` rather than
      // the draft is documentation, not logic: the guard above has already proven the two equal,
      // so it records where the values are supposed to come from.
      await this.api.calCacheStore([
        { idx, min: axis.min, centre: axis.centre, max: axis.max, selfCentring: d.selfCentring }
      ])
      const drafts = { ...this.state.drafts }
      delete drafts[idx]
      this.set({ device: read.value, drafts })
    }

    await this.refreshOffer()
    this.set({
      write: { phase: 'done', queue, at: queue.length - 1, stored: [...stored] }
    })
    this.hold(() => {
      this.set({ write: undefined })
      this.flash({ kind: 'written', axes: [...stored] })
    })
  }

  /**
   * Hold a finished state on screen before moving on.
   *
   * Long enough to read a short line, short enough not to block the next action — and always
   * cancellable, since the user may act before it fires.
   */
  private hold(then: () => void): void {
    this.clearHold()
    this.holdTimer = this.timers.setTimeout(then, 3000)
  }

  private clearHold(): void {
    if (this.holdTimer) this.timers.clearTimeout(this.holdTimer)
    this.holdTimer = undefined
  }

  /**
   * Show a confirmation for long enough to be read, then take it down.
   *
   * Carries which axes rather than a sentence: the wording is the dialog's business, and the
   * controller has no reason to reach into the renderer's label table.
   */
  private flash(notice: NonNullable<WorkflowState['notice']>): void {
    if (this.noticeTimer) this.timers.clearTimeout(this.noticeTimer)
    this.set({ notice })
    this.noticeTimer = this.timers.setTimeout(() => this.set({ notice: undefined }), 6000)
  }

  /** Does the device now hold exactly what this draft asked for? */
  private confirms(snap: CalSnapshot | undefined, idx: number): boolean {
    const d = this.state.drafts[idx]
    const a = snap?.axes[idx]
    return !!d && !!a && a.calibrated && a.min === d.min && a.centre === d.centre && a.max === d.max
  }

  /**
   * Stop the queue, keep the dirty state, and re-read.
   *
   * The re-read matters most on a timeout, which cannot distinguish "never received" from "wrote
   * it and the reply was lost". Reporting what the device actually holds is the only honest
   * answer, so this never claims nothing was written.
   */
  private async failWrite(f: CalFailure, axis: number, stored: number[]): Promise<void> {
    const read = await this.api.calRead()
    const device = read.ok ? read.value : this.state.device

    // A timeout cannot tell "never received" from "wrote it and the reply was lost" — so if the
    // re-read shows the device holding exactly what we asked for, the write *did* land. Say so:
    // leaving the draft dirty would invite the user to rewrite a value already verified, and
    // omitting the axis from `stored` would under-report what succeeded.
    const landed = this.confirms(device, axis)
    const drafts = { ...this.state.drafts }
    if (landed) delete drafts[axis]

    this.set({
      write: undefined,
      device,
      drafts,
      failure: { ...f, axis },
      storedBeforeFailure: landed ? [...stored, axis] : stored
    })
    await this.refreshOffer()
  }

  /**
   * Delete stored calibration for one axis. Persists immediately, same flash write as COMMIT —
   * so it fails the same ways, and needs the same read-back.
   */
  async deleteAxis(idx: number): Promise<void> {
    if (this.state.paused) return
    this.set({ busy: true, failure: undefined })
    const r = await this.api.calReset(idx)
    if (!r.ok) {
      const read = await this.api.calRead()
      this.set({
        busy: false,
        device: read.ok ? read.value : this.state.device,
        failure: { ...r, axis: idx }
      })
      return
    }
    // The ACK says "received". Only a read showing the axis uncalibrated says "erased" — same
    // rule the write path follows, and the reason the draft must not be discarded on the ACK
    // alone. A failed read, or an axis still calibrated, is a failure to report rather than a
    // refresh to shrug at.
    const read = await this.api.calRead()
    if (!read.ok) {
      this.set({ busy: false, failure: { ...read, axis: idx } })
      return
    }
    if (read.value.axes[idx]?.calibrated) {
      this.set({
        busy: false,
        device: read.value,
        failure: {
          kind: 'error',
          message: 'The device acknowledged the delete but still reports this axis as calibrated.',
          axis: idx
        }
      })
      return
    }
    // A deliberate erase has to reach the cache, or the client would turn round and offer to
    // restore exactly what the user just deleted — a later read cannot tell the two apart.
    await this.api.calCacheDrop(idx)
    const drafts = { ...this.state.drafts }
    delete drafts[idx]
    this.set({ busy: false, drafts, device: read.value })
    this.flash({ kind: 'erased', axes: [idx] })
  }

  /**
   * The serial link opened or closed (#74).
   *
   * Closing pauses rather than cancels. The ticker stops with it, and that matters: silence is
   * how a hold completes, so a ticker left running would commit whatever value the axis held
   * when the link dropped — an endpoint timed across an outage. Opening does not resume on its
   * own; resuming waits for the board's report, which says whether it is the same board.
   */
  linkChanged(up: boolean): void {
    this.linkUp = up
    if (!up) {
      this.stopTicking()
      if (!this.state.paused) this.set({ paused: true, streaming: false, switchingTo: undefined })
      return
    }
    // With no dialog open there is no session to restore.
    if (!this.state.open && this.state.paused) this.set({ paused: false })
  }

  /**
   * Take in the device's latest report, discarding work that belongs to a different board.
   *
   * While paused an absent report means "cannot ask", not "gone": the last snapshot is kept,
   * because it is what identifies the board the drafts were captured on when the link returns.
   */
  deviceChanged(next?: CalSnapshot): void {
    if (!next && this.state.paused) return
    if (boardOf(next) !== boardOf(this.state.device)) {
      // The restore offer and rest positions came from the old board's cache entry too. Kept,
      // a Restore would write that board's endpoints onto this one — and the read-back would
      // pass, caching them under the new serial. The resume below reads this board's own.
      this.set({
        device: next,
        drafts: {},
        capture: undefined,
        live: undefined,
        restorable: undefined,
        restoreOpen: false,
        restPosition: {}
      })
      this.seedOnResume = true
    } else {
      this.set({ device: next })
    }
    if (next && this.state.paused && this.state.open && this.linkUp) void this.resume()
  }

  /**
   * Reopen the session after the link returns, on the axis on screen.
   *
   * The device lost its session with the port, so nothing streams until this is acknowledged.
   * A sweep that was mid-capture starts again; its accepted sweeps are kept. A failed reopen
   * leaves the dialog paused, with the reason shown.
   */
  private async resume(): Promise<void> {
    if (this.resuming) return
    this.resuming = true
    const axis = this.state.axis
    const r = await this.api.calSessionOpen(axis)
    this.resuming = false
    // Closed again while the reopen was in flight: the next report will retry.
    if (!this.linkUp || !this.state.open) return
    if (!r.ok) {
      this.sessionFailure = { ...r, axis }
      this.set({ failure: this.sessionFailure })
      return
    }
    if (this.seedOnResume) {
      this.seedOnResume = false
      await this.seedFromCache()
    }
    const c = this.state.capture
    // A failed open or reopen is answered by this one succeeding; a failed write is not.
    const stale = this.state.failure && this.state.failure === this.sessionFailure
    this.sessionFailure = undefined
    this.set({
      ...(stale ? { failure: undefined } : {}),
      paused: false,
      streaming: false,
      live: undefined,
      capture: c?.phase === 'capturing' ? restartSweep(c, this.now()) : c
    })
    this.startTicking()
  }

  dispose(): void {
    this.stopTicking()
    this.clearHold()
    if (this.noticeTimer) this.timers.clearTimeout(this.noticeTimer)
    this.noticeTimer = undefined
    this.listeners.clear()
  }
}
