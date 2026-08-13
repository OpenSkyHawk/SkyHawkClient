// Orchestration for the calibration dialog: session lifecycle, sample routing, and the write
// sequence. Everything the dialog needs to *decide* lives here; the dialog renders and calls in.
//
// Depends on an injected API rather than window.skyhawk directly, so the whole flow is testable
// without Electron or a device.
import {
  beginCapture,
  midpoint,
  push as pushSample,
  retrySweep,
  tick,
  type CaptureResult,
  type CaptureState
} from '@shared/axis-capture'
import type {
  CalCacheEntry,
  CalCommitAxis,
  CalFailure,
  CalRawSample,
  CalResult,
  CalSnapshot
} from '@shared/ipc'
import type { CachedBoard } from '@shared/cal-cache'

/** Only the calls this controller makes — narrower than SkyhawkApi, and trivial to fake. */
export interface CalibrationApi {
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

/** Endpoints a user has captured or edited but not yet written. */
export interface DraftAxis extends CaptureResult {
  /** Whether this axis returns to rest. Defaults true; the user can override per axis. */
  selfCentring: boolean
  /**
   * The rest position as measured, kept even while a midpoint is in use.
   *
   * `centre` is the value that will be written, so switching to "no rest position" replaces it.
   * Without somewhere to keep the measurement, that switch is destructive and switching back
   * does not undo it: the user gets a midpoint that looks exactly as plausible as the rest
   * position they spent three sweeps capturing. Undefined when the capture never measured one.
   */
  capturedCentre?: number
}

export type WritePhase =
  /** Sending COMMIT for one axis. */
  | 'writing'
  /**
   * Re-reading after the ACK.
   *
   * A separate phase because an acknowledgement only means "received". The read-back is what
   * proves "stored", and the badges are driven from it rather than from what was sent.
   */
  | 'verifying'
  /**
   * Every axis stored, held on screen so the user can see it.
   *
   * The work is finished here — this phase exists only because the whole save takes a few
   * hundred milliseconds, and a result that vanishes as fast as it appeared is indistinguishable
   * from nothing having happened.
   */
  | 'done'

export interface WriteProgress {
  phase: WritePhase
  /** Axes queued for this save, in order. */
  queue: number[]
  /** Index within `queue` currently being written. */
  at: number
  /** Axes the device has confirmed storing, this save. */
  stored: number[]
}

export interface CalibrationState {
  open: boolean
  /** Axis the dialog is showing, and the one the device is streaming. */
  axis: number
  /** Latest snapshot the device confirmed. Badges and values come from here, never from drafts. */
  device?: CalSnapshot
  /** Per-axis edits not yet written. Survives switching axes. */
  drafts: Record<number, DraftAxis>
  /**
   * Whether each axis returns to rest, chosen by the user.
   *
   * Held separately from the drafts because the choice has to be made *before* capturing — it
   * decides whether the flow has a third point at all. Keying it to a draft would mean the first
   * capture on every axis ran the centre step regardless, and the setting only became reachable
   * once it was too late to matter. Defaults to true; see DraftAxis.selfCentring.
   */
  restPosition: Record<number, boolean>
  /**
   * Axis a STREAM_SELECT is in flight for, if any.
   *
   * `axis` does not move until the device acknowledges. Switching optimistically would leave us
   * filtering for an axis the gateway is not streaming — every sample dropped on `idx`, so the
   * readout and capture look dead — and retrying the same axis would early-return as a no-op.
   */
  switchingTo?: number
  /**
   * Whether a sample for the current axis has actually arrived since it was selected.
   *
   * The ACK proves the device accepted the selection; this proves data is flowing. Kept separate
   * and non-blocking because the node emits only on change: a steady axis may send nothing at
   * all, so gating the UI on it would read as a hang.
   */
  streaming: boolean
  /** Live capture for the axis on screen, absent when not capturing. */
  capture?: CaptureState
  /** Most recent sample for the streamed axis, for the live readout. */
  live?: { raw: number; cal: number }
  write?: WriteProgress
  /** Why the last operation failed. Cleared when the user acts again. */
  failure?: CalFailure & { axis?: number }
  /** Axes that did store before a failure stopped the queue — worth naming in the UI. */
  storedBeforeFailure?: number[]
  /**
   * A confirmation to hold on screen for a few seconds.
   *
   * Every one of these operations finishes in well under a second — a COMMIT plus a read-back is
   * two round trips against a 2 s timeout, and the erase is ~28 ms. Clearing the state the
   * instant the work is done means the only evidence anything happened is a flicker, which reads
   * as "nothing happened" rather than "done". Success needs to stay put long enough to be read.
   */
  notice?: { kind: 'written' | 'erased'; axes: number[] }
  /**
   * Axes the cache holds that the device has lost, and the copy itself.
   *
   * Present does not mean acted on. This is an *offer* — restoring automatically onto a board
   * whose calibration went missing would be right most of the time and catastrophic the rest,
   * because the one case that produces a missing calibration and a populated cache is also the
   * case where the board might have been swapped. Wrong endpoints fail open and stay invisible.
   */
  restorable?: { board: CachedBoard; axes: number[] }
  /** Whether the restore offer is expanded for review. Never restores without this. */
  restoreOpen: boolean
  busy: boolean
}

const emptyState = (): CalibrationState => ({
  open: false,
  axis: 0,
  drafts: {},
  restPosition: {},
  streaming: false,
  restoreOpen: false,
  busy: false
})

/**
 * Cheap identity for a device, so a stale snapshot is never shown against a different board.
 * VID/PID are identical across every gateway, so the serial is the only distinguishing field.
 */
const boardOf = (s?: CalSnapshot) => s?.serialNumber ?? null

export class CalibrationController {
  private state = emptyState()
  private listeners = new Set<(s: CalibrationState) => void>()
  private ticker?: ReturnType<typeof setInterval>
  private holdTimer?: ReturnType<typeof setTimeout>
  private noticeTimer?: ReturnType<typeof setTimeout>

  constructor(
    private readonly api: CalibrationApi,
    /** Injected so tests can drive time; defaults to the wall clock. */
    private readonly now: () => number = () => Date.now()
  ) {}

  subscribe(fn: (s: CalibrationState) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  snapshot(): CalibrationState {
    return this.state
  }

  private set(patch: Partial<CalibrationState>): void {
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
    this.set({ ...emptyState(), open: true, axis, device, busy: true })
    const r = await this.api.calSessionOpen(axis)
    if (!r.ok) {
      this.set({ busy: false, failure: { ...r, axis } })
      return
    }
    // The rest position is part of the calibration, but the device has no field for it — there is
    // deliberately no axis type in the blob. So it comes back from the cache, or every axis would
    // silently revert to the self-centring default and a throttle would be asked to release to a
    // rest position it does not have.
    const cache = await this.api.calCacheRead()
    const restPosition = { ...this.state.restPosition }
    let restorable: CalibrationState['restorable']
    if (cache.ok && cache.value.board) {
      for (const [key, a] of Object.entries(cache.value.board.axes)) {
        restPosition[Number(key)] = a.selfCentring
      }
      if (cache.value.regressed.length > 0) {
        restorable = { board: cache.value.board, axes: cache.value.regressed }
      }
    }
    this.set({ busy: false, failure: undefined, restPosition, restorable })
    this.startTicking()
  }

  /**
   * Switch the axis on screen, and the one the device streams.
   *
   * Drafts are keyed by axis and deliberately survive this — #46 requires edits to persist when
   * moving along the rail, and they are written together at the end.
   */
  async selectAxis(axis: number): Promise<void> {
    if (axis === this.state.axis || this.state.switchingTo === axis) return
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
    this.set(emptyState())
  }

  // ── sampling ───────────────────────────────────────────────────────────────

  /**
   * Feed a batch of RAW samples.
   *
   * Samples for other axes are dropped rather than fed to the capture: a frame can be in flight
   * across a STREAM_SELECT, and RAW carries `idx` precisely so it can be discarded.
   */
  ingest(samples: CalRawSample[]): void {
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
    if (!r || this.state.write) return
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
    this.set({
      capture: beginCapture(this.now(), this.selfCentring()),
      failure: undefined
    })
  }

  /** Acknowledge a rejected sweep and redo it, keeping the accepted ones. */
  retry(): void {
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
    this.ticker = setInterval(() => {
      const c = this.state.capture
      if (!c || c.phase !== 'capturing') return
      const next = tick(c, this.now())
      if (next !== c) this.advanceCapture(next)
    }, 100)
  }

  private stopTicking(): void {
    if (this.ticker) clearInterval(this.ticker)
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
  private advanceCapture(capture: CaptureState | undefined, extra: Partial<CalibrationState> = {}) {
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
    if (!queue.length || this.state.write) return

    this.set({ write: { phase: 'writing', queue, at: 0, stored: [] }, failure: undefined })
    const stored: number[] = []

    for (let at = 0; at < queue.length; at++) {
      const idx = queue[at]!
      const d = this.state.drafts[idx]!
      this.set({ write: { phase: 'writing', queue, at, stored: [...stored] } })

      const commit = await this.api.calCommit({ idx, min: d.min, centre: d.centre, max: d.max })
      if (!commit.ok) {
        await this.failWrite(commit, idx, stored)
        return
      }

      // The ACK said "received". Only the read-back says "stored".
      this.set({ write: { phase: 'verifying', queue, at, stored: [...stored] } })
      const read = await this.api.calRead()
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
    this.holdTimer = setTimeout(then, 2200)
  }

  private clearHold(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer)
    this.holdTimer = undefined
  }

  /**
   * Show a confirmation for long enough to be read, then take it down.
   *
   * Carries which axes rather than a sentence: the wording is the dialog's business, and the
   * controller has no reason to reach into the renderer's label table.
   */
  private flash(notice: NonNullable<CalibrationState['notice']>): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.set({ notice })
    this.noticeTimer = setTimeout(() => this.set({ notice: undefined }), 6000)
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
  }

  /**
   * Delete stored calibration for one axis. Persists immediately, same flash write as COMMIT —
   * so it fails the same ways, and needs the same read-back.
   */
  async deleteAxis(idx: number): Promise<void> {
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

  /** Discard a snapshot that describes a board no longer attached. */
  deviceChanged(next?: CalSnapshot): void {
    if (boardOf(next) !== boardOf(this.state.device)) {
      this.set({ device: next, drafts: {}, capture: undefined, live: undefined })
    } else {
      this.set({ device: next })
    }
  }

  dispose(): void {
    this.stopTicking()
    this.clearHold()
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.noticeTimer = undefined
    this.listeners.clear()
  }
}
