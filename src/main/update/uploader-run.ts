// One flash through the Gateway's uploader (#366), as every target's update runs it: the Gateway's
// cockpit side (#187) and the boards on the bus (#175). The flows (cockpit-side-update.ts, and the
// boards') keep what is their own — which image, whether one is staged at all, what a lost result
// means for that board — and share this.
//
// It owns the uploader's phases as the dialog's steps, for every target (#177 adds `setid`):
// ENTERING_BOOT / CONNECTED → boot, ERASING / WRITING → write, VERIFYING → verify, REBOOTING →
// restart, CONFIRMING → ver. A retry (`attempt` ≥ 1) never moves a step back: it is a note, then
// "recovered" once its write is through. It owns what a result says was left behind — nothing
// written, or the board in its bootloader — which picks the footer.
//
// The client may lose contact mid-flash (the port closed, the PC slept): the Gateway finishes on its
// own. The run waits for the link, then reads UPL_INFO: still flashing → follow it; a result → that
// result; no result at all (the USB side lost power, RAM only) → the flow's board row decides.
import type { LogEventInput } from '@shared/events'
import { UPL_PROTO, type UplPhaseName } from '@shared/firmware'
import type { UpdateFailure, UpdateRefusal, UpdateStepKey } from '@shared/update'
import { checkImageFor, type ImageIdentity, type ImageWant } from './firmware-image'
import type { RunResult, StepReport } from './update-flow'
import type { UplInfo, UplOutcome, UplStatus } from './uploader/upl-codec'
import {
  outcomeOf,
  UplNoAnswer,
  UplRefused,
  type FlashEnd,
  type UploaderClient
} from './uploader/uploader-client'

/** Each uploader phase as the dialog's step (SETTING_ID is #177's, `setid`). */
const PHASE_STEP: Partial<Record<UplPhaseName, UpdateStepKey>> = {
  ENTERING_BOOT: 'boot',
  CONNECTED: 'boot',
  ERASING: 'write',
  WRITING: 'write',
  VERIFYING: 'verify',
  REBOOTING: 'restart',
  CONFIRMING: 'ver'
}

/** From the erase on, the board's app is gone: it waits in its bootloader until an image lands. */
const ERASED: ReadonlySet<UplPhaseName> = new Set([
  'ERASING',
  'WRITING',
  'VERIFYING',
  'REBOOTING',
  'CONFIRMING'
])

/** The phases a retry's write is through at: the note becomes "recovered". */
const PAST_WRITE: ReadonlySet<UplPhaseName> = new Set(['VERIFYING', 'REBOOTING', 'CONFIRMING'])

const REFUSAL: Partial<Record<string, UpdateRefusal>> = {
  KIND_MISMATCH: 'wrong-kind',
  ID_MISMATCH: 'wrong-id',
  TOO_BIG_FOR_BOARD: 'too-big'
}

/** A failed run's result. Retry always reads UPL_INFO first, and starts from there. */
export function failed(
  failure: UpdateFailure,
  at: number,
  after?: 'refused' | 'erased'
): RunResult {
  return { ok: false, failure, at, retryFrom: 0, ...(after && { after }) }
}

/** A saved image, read once: its bytes and identity, or why not (#192's words, or none: damaged). */
export type ReadImage =
  | { ok: true; bytes: Uint8Array; id: ImageIdentity }
  | { ok: false; message: string }

/** What a run needs besides the uploader (the flow hands its own ports in). */
export interface UploaderRunPorts {
  /** The link is up. */
  linkUp(): boolean
  events: (rows: LogEventInput[]) => void
  now: () => number
}

/** The client's own waits. Not firmware values. */
export interface UploaderRunTiming {
  /** How often the link is looked for while the client is cut off. */
  pollMs: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** How a flash ended once contact is back: its result, a USB side that lost it, or Close left it. */
export type Settled = { outcome: UplOutcome } | { powerCycled: true } | { left: true }

/**
 * A target's runs through the uploader: the flash and its statuses, staging a checked image, and
 * waiting out a loss of contact. One per flow; Close may leave a run that waits for the Gateway.
 */
export class UploaderRun {
  /** The run lost the Gateway and waits for it: Close may leave it (`detach`). */
  private leave?: () => void

  constructor(
    readonly uploader: UploaderClient,
    private readonly ports: UploaderRunPorts,
    private readonly timing: UploaderRunTiming
  ) {}

  /** The run waits for a Gateway it lost: Close may leave it to finish on its own. */
  detachable(): boolean {
    return !!this.leave
  }

  /** Close while cut off: stop waiting; the Gateway finishes on its own. */
  detach(): void {
    this.leave?.()
  }

  /**
   * UPL_FLASH `target`. With no answer to it nor to the UPL_INFO after it (the link went as it was
   * sent), whether it started is unknown: the run waits for the Gateway and reads UPL_INFO, as after
   * any loss of contact — it may be flashing.
   * @throws UplRefused: nothing started.
   */
  async flash(target: number, newNodeId: number, watch: FlashWatch): Promise<FlashEnd> {
    try {
      return await this.uploader.flash(target, newNodeId, watch.status)
    } catch (e) {
      if (e instanceof UplNoAnswer) return { lost: true }
      throw e
    }
  }

  /**
   * Stage `image` once it checks out against `want`: built for the board, the version expected,
   * intact. A failure as the run's result (the flow's `damaged` words when the check fails), or
   * undefined once it is staged.
   */
  async stage(
    image: ReadImage,
    want: ImageWant,
    damaged: UpdateFailure,
    report: StepReport
  ): Promise<RunResult | undefined> {
    if (!image.ok)
      return failed(image.message ? { kind: 'image', message: image.message } : damaged, 0)
    if (!checkImageFor(image.bytes, want).ok) return failed(damaged, 0)
    try {
      await this.uploader.stage(image.bytes, image.id, (n) => report.pct(n))
    } catch (e) {
      if (e instanceof UplRefused && e.reason === 'BUSY') return failed({ kind: 'busy' }, 0)
      if (e instanceof UplRefused || e instanceof UplNoAnswer)
        return failed({ kind: 'no-answer' }, 0)
      throw e
    }
    return undefined
  }

  /** Until the flash's result: through any loss of contact. */
  async settle(end: FlashEnd, watch: FlashWatch, report: StepReport): Promise<Settled> {
    for (;;) {
      if (!end.lost) {
        // Read from UPL_INFO with no result kept: the USB side restarted before the probe missed.
        return end.outcome.result === 'NONE' ? { powerCycled: true } : { outcome: end.outcome }
      }
      watch.partial = true // statuses sent meanwhile never reached the client
      const back = this.reconnect() // Close may leave it from the push below on
      report.note?.({ kind: 'cut-off' })
      const info = await back
      // Closed meanwhile: the Gateway finishes on its own; nobody reads this result.
      if (!info) return { left: true }
      report.note?.({ kind: 'back' })
      if (info.state === 'FLASHING') {
        end = await this.uploader.follow(watch.status)
        continue
      }
      // The USB side restarted: its uploader lost the session and the result (RAM only).
      return info.lastResult === 'NONE' ? { powerCycled: true } : { outcome: outcomeOf(info) }
    }
  }

  /**
   * Wait for the link and an uploader that answers: no limit of its own, the link keeps looking —
   * until Close leaves it (undefined).
   */
  private async reconnect(): Promise<UplInfo | undefined> {
    const left = new Promise<'left'>((resolve) => (this.leave = () => resolve('left')))
    try {
      for (;;) {
        if ((await Promise.race([sleep(this.timing.pollMs), left])) === 'left') return undefined
        if (!this.ports.linkUp()) continue
        const info = await Promise.race([this.uploader.info(), left])
        if (info === 'left') return undefined
        if (info) return info
      }
    } finally {
      this.leave = undefined
    }
  }

  /**
   * A result, as every target reads it. `name` and `to` word the error event a refusal logs. The
   * flow handles OK's version, TIMEOUT and VERSION_MISMATCH itself when its board needs more (a
   * board re-judged from its row, #175); these are the defaults.
   */
  outcome(o: UplOutcome, watch: FlashWatch, board: { name: string; to: string }): RunResult {
    const at = watch.furthest
    const after = watch.mayBeErased ? ('erased' as const) : ('refused' as const)
    switch (o.result) {
      case 'OK':
        return { ok: true, reports: o.fw ?? board.to }
      case 'NO_RESPONSE':
        return failed({ kind: 'no-response' }, at, 'refused')
      case 'NO_BOOTLOADER':
        return failed({ kind: 'no-bootloader' }, at, 'refused')
      case 'KIND_MISMATCH':
      case 'ID_MISMATCH':
      case 'TOO_BIG_FOR_BOARD': {
        // Never expected: the image was checked against the board before it was sent.
        const why = REFUSAL[o.result]!
        this.ports.events([
          {
            t: this.ports.now(),
            source: 'client',
            name: board.name,
            severity: 'error',
            event: 'update refused',
            detail: `firmware ${board.to} · ${o.result}`,
            raw: `update: UPL_RESULT ${o.result} · target ${o.target}`
          }
        ])
        return failed({ kind: 'refused', why }, at, after)
      }
      case 'WRITE_FAILED':
      case 'VERIFY_FAILED':
        // Only ever after the erase began (Uploader.cpp): it waits in its bootloader.
        return failed({ kind: 'write-failed' }, at, 'erased')
      case 'TIMEOUT':
        return failed({ kind: 'no-confirmation' }, at)
      case 'VERSION_MISMATCH':
        return failed({ kind: 'wrong-version', reported: o.fw ?? '' }, at)
      default:
        return failed({ kind: 'unknown-result' }, at)
    }
  }
}

/**
 * One flash's statuses as the dialog's steps: the furthest step reached (never back), writing's
 * high-water mark, whether the erase happened, and the retry note.
 */
export class FlashWatch {
  furthest = 0
  erased = false
  /** Statuses may have been missed: the client was cut off, or joined a flash mid-way. */
  partial = false
  private pct = 0
  /** The retry the note names (0: none yet), and whether its write is through. */
  private attempt = 0
  private retrying = false

  constructor(
    private readonly flow: { steps(): readonly UpdateStepKey[] },
    private readonly report: StepReport
  ) {}

  /** The erase may have happened: seen, or not seen but statuses were missed. */
  get mayBeErased(): boolean {
    return this.erased || this.partial
  }

  readonly status = (s: UplStatus): void => {
    if (!s.phase) return
    if (ERASED.has(s.phase)) this.erased = true
    const key = PHASE_STEP[s.phase]
    const idx = key ? this.flow.steps().indexOf(key) : -1
    if (idx > this.furthest) {
      this.furthest = idx
      this.pct = 0
      this.report.step(idx)
    }
    if (key === 'write' && idx === this.furthest && s.blocks) {
      const n = Math.round((Math.min(s.block, s.blocks) / s.blocks) * 100)
      if (n > this.pct) {
        this.pct = n
        this.report.pct(n)
      }
    }
    if (s.attempt > this.attempt) {
      this.attempt = s.attempt
      this.retrying = true
      this.report.note?.({ kind: 'retrying', n: s.attempt, of: UPL_PROTO.retries })
    } else if (this.retrying && PAST_WRITE.has(s.phase)) {
      this.retrying = false
      this.report.note?.({ kind: 'recovered' })
    }
  }
}
