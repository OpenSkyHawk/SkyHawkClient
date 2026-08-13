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
import type { CalCommitAxis, CalFailure, CalRawSample, CalResult, CalSnapshot } from '@shared/ipc'

/** Only the calls this controller makes — narrower than SkyhawkApi, and trivial to fake. */
export interface CalibrationApi {
  calRead(): Promise<CalResult<CalSnapshot>>
  calSessionOpen(axisIdx: number): Promise<CalResult<{ timeoutMs: number; axisIdx: number }>>
  calStreamSelect(axisIdx: number): Promise<CalResult<null>>
  calCommit(axis: CalCommitAxis): Promise<CalResult<null>>
  calReset(idx: number): Promise<CalResult<null>>
  calSessionClose(): Promise<CalResult<null>>
}

/** Endpoints a user has captured or edited but not yet written. */
export interface DraftAxis extends CaptureResult {
  /** Whether this axis returns to rest. Defaults true; the user can override per axis. */
  selfCentring: boolean
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
  busy: boolean
}

const emptyState = (): CalibrationState => ({
  open: false,
  axis: 0,
  drafts: {},
  restPosition: {},
  streaming: false,
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
    this.set({ busy: false, failure: undefined })
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
      this.set({ capture, live, streaming: true })
    }
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
      if (next !== c) {
        this.set({ capture: next })
        if (next.phase === 'complete' && next.result) this.bankResult(next.result)
      }
    }, 100)
  }

  private stopTicking(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = undefined
  }

  /** A finished capture becomes a draft; nothing is written until the user saves. */
  private bankResult(result: CaptureResult): void {
    const selfCentring = this.state.capture?.selfCentring ?? this.selfCentring()
    this.set({
      drafts: { ...this.state.drafts, [this.state.axis]: { ...result, selfCentring } },
      capture: undefined
    })
  }

  /** Whether the axis on screen is set to return to rest. Defaults true for every axis. */
  selfCentring(axis = this.state.axis): boolean {
    return this.state.restPosition[axis] ?? true
  }

  /**
   * Change the rest-position setting for the axis on screen.
   *
   * Works before a capture as well as after — that is the point, since the setting decides
   * whether the capture has a centre step. When a draft already exists its centre is re-derived,
   * because switching to "no rest position" means the captured rest value no longer applies.
   */
  setSelfCentring(selfCentring: boolean): void {
    const axis = this.state.axis
    const restPosition = { ...this.state.restPosition, [axis]: selfCentring }
    const d = this.state.drafts[axis]
    if (!d) {
      this.set({ restPosition })
      return
    }
    const centre = selfCentring ? d.centre : midpoint(d.min, d.max)
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
      const drafts = { ...this.state.drafts }
      delete drafts[idx]
      this.set({ device: read.value, drafts })
    }

    this.set({ write: undefined })
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
    const drafts = { ...this.state.drafts }
    delete drafts[idx]
    this.set({ busy: false, drafts, device: read.value })
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
    this.listeners.clear()
  }
}
