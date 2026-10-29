// Updating the Gateway's cockpit side, node 0 (#187), through the Gateway's uploader (#366, #367).
// Usually nothing is sent: the USB side's firmware carries the cockpit side's image (the bundle),
// and UPL_FLASH 0 with nothing staged flashes it. A USB side built without it (`bridgeFw` 0.0.0)
// gets the release's image staged first, checked against its identity block before a byte goes.
//
// This owns the uploader's phases as the dialog's steps, for every target (#175 and #177 reuse
// it): ENTERING_BOOT / CONNECTED → boot, ERASING / WRITING → write, VERIFYING → verify, REBOOTING →
// restart, CONFIRMING → ver. A retry (`attempt` ≥ 1) never moves a step back: it is a note, then
// "recovered" once its write is through. And it owns what each result means for node 0: whether
// anything was written decides the footer and whether the cockpit side returns to its app by itself
// (Boot::IDLE_TIMEOUT_MS), when its silence isn't "not responding".
//
// The client may lose contact mid-flash (the port closed, the PC slept): the Gateway finishes on its
// own. The run waits for the link, then reads UPL_INFO: still flashing → follow it; a result → that
// result; no result at all (the USB side lost power, RAM only) → the node-0 row decides.
import type { LogEventInput } from '@shared/events'
import {
  GATEWAY_NODE_ID,
  NODE_KINDS,
  UPL_PROTO,
  UPL_TARGET,
  type UplPhaseName
} from '@shared/firmware'
import type { ReleaseTarget } from '@shared/releases'
import type { UpdateCheck, UpdateFailure, UpdateRefusal, UpdateStepKey } from '@shared/update'
import { checkImageFor, parseIdentity, type ImageIdentity } from './firmware-image'
import type { FlowView, RunResult, StepReport, UpdateFlow } from './update-flow'
import type { UplInfo, UplOutcome, UplStatus } from './uploader/upl-codec'
import {
  UplNoAnswer,
  UplRefused,
  type FlashEnd,
  type UploaderClient
} from './uploader/uploader-client'

/** The cockpit side's rough time (FP07:459-462: 4.1 s from the bundle on the bench). */
export const COCKPIT_ESTIMATE_SEC = 5

const BUNDLE_STEPS: readonly UpdateStepKey[] = ['boot', 'write', 'verify', 'restart', 'ver']
const STAGE_STEPS: readonly UpdateStepKey[] = ['stage', ...BUNDLE_STEPS]

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

/** What the flow needs from the rest of the app (app hands each in, through CockpitSide). */
export interface CockpitSidePorts {
  /** The cockpit side's image of a saved `version` (#192 getFile, node 0's `bin`, SHA-256 checked). */
  image(
    version: string
  ): Promise<{ ok: true; bytes: Uint8Array; name: string } | { ok: false; message: string }>
  /** The cockpit side's own row now: its version, or nothing (no row since the port opened). */
  bridgeVersion(): string | undefined
  /** The link is up. */
  linkUp(): boolean
  /** A calibration session is open on the Gateway. */
  calibrationOpen(): boolean
  events: (rows: LogEventInput[]) => void
  now: () => number
}

/** The client's own waits. Not firmware values. */
export interface CockpitSideTiming {
  /** How often the link is looked for while the client is cut off. */
  pollMs: number
  /**
   * After a reconnect that lost the result (the USB side lost power): how long to wait for the
   * cockpit side's row, which the connect's roster request brings at once.
   */
  rowMs: number
}

const TIMING: CockpitSideTiming = { pollMs: 1000, rowMs: 6000 }

/** What the dialog was opened with: the uploader as the connect read it, and where it stands. */
export interface CockpitSideOpen {
  /** The version to install: the bundle's, else the saved release's. */
  to: string
  /** The USB side carries it: nothing is sent. */
  bundle: boolean
  /** The release, for a staged image (no bundle). */
  release?: ReleaseTarget
  /** The USB side's release from HELLO this connect. */
  usb?: string
  /** The cockpit side doesn't respond: the update is a retry. */
  notResponding: boolean
  /** The USB side answered UPL_INFO this connect. */
  uploader: () => boolean
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const major = (v: string) => Number(v.split('.')[0])

/** Told by the flow about its run, for what nodes show (CockpitSide owns it). */
export interface CockpitRunHooks {
  /** The run started or ended: the cockpit pauses meanwhile. */
  running(on: boolean): void
  /**
   * The run ended with nothing written while the cockpit side may sit in its bootloader: it
   * returns to its app by itself (Boot::IDLE_TIMEOUT_MS), so its silence meanwhile isn't news.
   */
  settling(): void
}

export class CockpitSideUpdate implements UpdateFlow {
  readonly target = { kind: 'cockpit' } as const
  readonly name = 'Gateway · cockpit side'
  readonly estimateSec = COCKPIT_ESTIMATE_SEC
  readonly to: string
  private readonly timing: CockpitSideTiming
  /** The run stages the release's image: no bundle, or the Gateway said NOT_STAGED. */
  private staging: boolean
  /** The image the Gateway holds staged is this run's (the bundle copy after a flash included). */
  private ours = false
  /** The saved image, read and checked once: its bytes and identity, or why not. */
  private image?:
    | { ok: true; bytes: Uint8Array; id: ImageIdentity }
    | { ok: false; message: string }
  /** The last run ended with no answer from the board: a Retry says to press its reset button. */
  private pressReset = false
  /**
   * The run lost the Gateway and waits for it: Close may leave it (`detach`), and the Gateway
   * finishes on its own; a later update reads UPL_INFO and follows it.
   */
  private leave?: () => void

  constructor(
    private readonly open: CockpitSideOpen,
    private readonly uploader: UploaderClient,
    private readonly ports: CockpitSidePorts,
    private readonly hooks: CockpitRunHooks,
    timing?: Partial<CockpitSideTiming>
  ) {
    this.to = open.to
    this.staging = !open.bundle
    this.timing = { ...TIMING, ...timing }
  }

  steps(): readonly UpdateStepKey[] {
    return this.staging ? STAGE_STEPS : BUNDLE_STEPS
  }

  first(): number {
    return 0
  }

  /**
   * Read the release's image for the confirm step (no bundle): its identity block says whom it is
   * built for and its size. Resolves once read; a failure shows at the run.
   */
  async prepare(): Promise<void> {
    if (this.staging) await this.readImage()
  }

  checks(): UpdateCheck[] {
    const o = this.open
    const img = this.image?.ok ? this.image.id : undefined
    return [
      { kind: 'link', ok: this.ports.linkUp() },
      { kind: 'uploader', ok: o.uploader() },
      { kind: 'calibration', ok: !this.ports.calibrationOpen() },
      o.bundle
        ? { kind: 'image', ok: true, version: this.to, bundle: true }
        : {
            kind: 'image',
            ok: !!o.release && o.release.version === this.to && o.release.hasImage({ nodeId: 0 }),
            version: this.to,
            ...(!this.image && { checking: true as const })
          },
      ...(img && !o.bundle
        ? [
            {
              kind: 'built-for' as const,
              ok: img.nodeId === GATEWAY_NODE_ID && img.nodeKind === NODE_KINDS.BRIDGE,
              nodeId: GATEWAY_NODE_ID
            },
            {
              kind: 'fits' as const,
              ok: img.imageLength <= UPL_PROTO.maxImageBytes,
              maxKb: UPL_PROTO.maxImageBytes / 1024
            }
          ]
        : [])
    ]
  }

  view(): FlowView {
    const o = this.open
    const img = this.image?.ok ? this.image.id : undefined
    // The two sides on different majors: only a staged image on a dev USB side can do that.
    const halves =
      img && o.usb && major(img.version) !== major(o.usb)
        ? { usb: major(o.usb), cockpit: major(img.version) }
        : undefined
    const from = this.ports.bridgeVersion()
    return {
      ...(o.bundle && { bundle: true as const }),
      ...(o.notResponding ? { fromState: 'not-responding' as const } : from && { from }),
      ...(img && !o.bundle && { sizeKb: Math.ceil(img.imageLength / 1024) }),
      ...(halves && { halves })
    }
  }

  /** The run waits for a Gateway it lost: Close may leave it to finish on its own. */
  detachable(): boolean {
    return !!this.leave
  }

  /** Close while cut off: stop waiting; the cockpit's pause and the roster hold end with the run. */
  detach(): void {
    this.leave?.()
  }

  /** The dialog closed after a result or a failure: drop what is staged (`BUSY` while flashing). */
  close(phase: 'confirm' | 'fail' | 'done'): void {
    if (phase === 'confirm') return
    this.ours = false
    void this.uploader.abort()
  }

  async run(_from: number, report: StepReport): Promise<RunResult> {
    this.hooks.running(true)
    report.note?.(this.pressReset ? { kind: 'press-reset' } : { kind: 'paused' })
    const result = await this.attempt(report).catch(
      (): RunResult => this.fail({ kind: 'no-answer' }, 0)
    )
    this.hooks.running(false)
    this.pressReset = !result.ok && result.failure.kind === 'no-response'
    // A flash that wrote nothing may leave it in its bootloader, which it leaves by itself.
    if (!result.ok && result.after === 'refused') this.hooks.settling()
    return result
  }

  // ── the run ────────────────────────────────────────────────────────────────

  private fail(failure: UpdateFailure, at: number, after?: 'refused' | 'erased'): RunResult {
    // Retry always reads UPL_INFO first, and starts from there.
    return { ok: false, failure, at, retryFrom: 0, ...(after && { after }) }
  }

  private at(key: UpdateStepKey): number {
    return Math.max(0, this.steps().indexOf(key))
  }

  private async attempt(report: StepReport): Promise<RunResult> {
    const up = this.uploader
    const info = await up.info()
    if (!info) return this.fail({ kind: 'no-uploader' }, 0)
    const watch = new FlashWatch(this, report)
    // A flash already running (ours, from before the client lost it): never aborted (BUSY); wait
    // for its result.
    if (info.state === 'FLASHING') {
      report.step(this.at('boot'))
      watch.partial = true // joined mid-flash: its earlier statuses were never seen
      return this.settle(await up.follow(watch.status), watch, report)
    }
    // Something staged that isn't this run's (a board's image, #175) would be flashed in place of
    // the bundle, and refused before the erase: drop it first.
    if ((info.state === 'STAGING' || info.state === 'STAGED') && !this.ours) {
      await up.abort()
    }
    let staged = info.state === 'STAGED' && this.ours
    if (!staged && this.staging) {
      const r = await this.stage(report)
      if (r) return r
      staged = true
    }
    report.step(this.at('boot'))
    let end: FlashEnd
    try {
      end = await this.flash(watch)
    } catch (e) {
      // The bundle is gone (a dev USB side) or was never there: stage the release's image instead.
      if (e instanceof UplRefused && e.reason === 'NOT_STAGED' && !staged) {
        this.staging = true
        const r = await this.stage(report)
        if (r) return r
        report.step(this.at('boot'))
        try {
          end = await this.flash(watch)
        } catch (again) {
          return this.refusedAtFlash(again)
        }
      } else {
        return this.refusedAtFlash(e)
      }
    }
    this.ours = true // after any result the image stays staged (Uploader.cpp finish)
    return this.settle(end, watch, report)
  }

  /**
   * UPL_FLASH 0. With no answer to it nor to the UPL_INFO after it (the link went as it was sent),
   * whether it started is unknown: the run waits for the Gateway and reads UPL_INFO, as after any
   * loss of contact — it may be flashing.
   */
  private async flash(watch: FlashWatch): Promise<FlashEnd> {
    try {
      return await this.uploader.flash(UPL_TARGET.bridge, UPL_TARGET.nodeIdKeep, watch.status)
    } catch (e) {
      if (e instanceof UplNoAnswer) return { lost: true }
      throw e
    }
  }

  /** UPL_FLASH refused: nothing started. */
  private refusedAtFlash(e: unknown): RunResult {
    if (e instanceof UplRefused && e.reason === 'BUSY') return this.fail({ kind: 'busy' }, 0)
    if (e instanceof UplRefused) return this.fail({ kind: 'no-answer' }, this.at('boot'))
    throw e
  }

  /** Read and check the saved image once: built for node 0, the target version, intact. */
  private async readImage(): Promise<void> {
    if (this.image?.ok) return
    const img = await this.ports.image(this.to)
    if (!img.ok) {
      this.image = { ok: false, message: img.message }
      return
    }
    const id = parseIdentity(img.bytes)
    this.image = id.ok ? { ok: true, bytes: img.bytes, id: id.id } : { ok: false, message: '' }
  }

  /** Stage the release's image; a failure as the run's result, or undefined once it is staged. */
  private async stage(report: StepReport): Promise<RunResult | undefined> {
    report.step(this.at('stage'))
    await this.readImage()
    const img = this.image!
    const damaged = {
      kind: 'image' as const,
      message: `The saved image of firmware ${this.to} is damaged.`
    }
    if (!img.ok)
      return this.fail(img.message ? { kind: 'image', message: img.message } : damaged, 0)
    const check = checkImageFor(img.bytes, {
      nodeId: GATEWAY_NODE_ID,
      nodeKind: NODE_KINDS.BRIDGE,
      version: this.to
    })
    if (!check.ok) return this.fail(damaged, 0)
    try {
      await this.uploader.stage(img.bytes, img.id, (n) => report.pct(n))
    } catch (e) {
      if (e instanceof UplRefused && e.reason === 'BUSY') return this.fail({ kind: 'busy' }, 0)
      if (e instanceof UplRefused || e instanceof UplNoAnswer) {
        return this.fail({ kind: 'no-answer' }, 0)
      }
      throw e
    }
    this.ours = true
    return undefined
  }

  /** Until the flash's result: through any loss of contact, then what it means. */
  private async settle(end: FlashEnd, watch: FlashWatch, report: StepReport): Promise<RunResult> {
    let outcome: UplOutcome | 'power-cycled'
    for (;;) {
      if (!end.lost) {
        // Read from UPL_INFO with no result kept: the USB side restarted before the probe missed.
        outcome = end.outcome.result === 'NONE' ? 'power-cycled' : end.outcome
        break
      }
      watch.partial = true // statuses sent meanwhile never reached the client
      const back = this.reconnect() // Close may leave it from the push below on
      report.note?.({ kind: 'cut-off' })
      const info = await back
      // Closed meanwhile: the Gateway finishes on its own; nobody reads this result.
      if (!info) return this.fail({ kind: 'no-answer' }, watch.furthest)
      report.note?.({ kind: 'back' })
      if (info.state === 'FLASHING') {
        end = await this.uploader.follow(watch.status)
        continue
      }
      // The USB side restarted: its uploader lost the session and the result (RAM only).
      outcome =
        info.lastResult === 'NONE'
          ? 'power-cycled'
          : {
              via: 'info',
              result: info.lastResult,
              target: info.lastTarget,
              ...(info.lastFw && { fw: info.lastFw })
            }
      break
    }
    if (outcome === 'power-cycled') return this.judgeFromRow(watch)
    return this.outcome(outcome, watch)
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

  /** The result was lost with the USB side's power: the cockpit side's own row says what it runs. */
  private async judgeFromRow(watch: FlashWatch): Promise<RunResult> {
    const end = this.ports.now() + this.timing.rowMs
    let version = this.ports.bridgeVersion()
    while (!version && this.ports.now() < end) {
      await sleep(this.timing.pollMs / 4)
      version = this.ports.bridgeVersion()
    }
    if (version === this.to) return { ok: true, reports: version }
    if (version) return this.fail({ kind: 'interrupted' }, watch.furthest, 'refused')
    // No row: written into — or maybe, with statuses missed — it waits in its bootloader; else it
    // returns to its app by itself.
    return watch.mayBeErased
      ? this.fail({ kind: 'not-responding' }, watch.furthest, 'erased')
      : this.fail({ kind: 'interrupted' }, watch.furthest, 'refused')
  }

  /** A result, for node 0. */
  private outcome(o: UplOutcome, watch: FlashWatch): RunResult {
    const at = watch.furthest
    const after = watch.mayBeErased ? ('erased' as const) : ('refused' as const)
    switch (o.result) {
      case 'OK':
        return { ok: true, reports: o.fw ?? this.to }
      case 'NO_RESPONSE':
        return this.fail({ kind: 'no-response' }, at, 'refused')
      case 'NO_BOOTLOADER':
        return this.fail({ kind: 'no-bootloader' }, at, 'refused')
      case 'KIND_MISMATCH':
      case 'ID_MISMATCH':
      case 'TOO_BIG_FOR_BOARD': {
        // Never expected: the image was checked (the bundle is always the bridge build).
        const why = REFUSAL[o.result]!
        this.ports.events([
          {
            t: this.ports.now(),
            source: 'client',
            name: this.name,
            severity: 'error',
            event: 'update refused',
            detail: `firmware ${this.to} · ${o.result}`,
            raw: `update: UPL_RESULT ${o.result} · target ${o.target}`
          }
        ])
        return this.fail({ kind: 'refused', why }, at, after)
      }
      case 'WRITE_FAILED':
      case 'VERIFY_FAILED':
        // Only ever after the erase began (Uploader.cpp): it waits in its bootloader.
        return this.fail({ kind: 'write-failed' }, at, 'erased')
      case 'TIMEOUT':
        return this.fail({ kind: 'no-confirmation' }, at)
      case 'VERSION_MISMATCH':
        return this.fail({ kind: 'wrong-version', reported: o.fw ?? '' }, at)
      default:
        return this.fail({ kind: 'unknown-result' }, at)
    }
  }
}

/**
 * One flash's statuses as the dialog's steps: the furthest step reached (never back), writing's
 * high-water mark, whether the erase happened, and the retry note.
 */
class FlashWatch {
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
