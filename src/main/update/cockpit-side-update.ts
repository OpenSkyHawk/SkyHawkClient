// Updating the Gateway's cockpit side, node 0 (#187), through the Gateway's uploader (#366, #367).
// Usually nothing is sent: the USB side's firmware carries the cockpit side's image (the bundle),
// and UPL_FLASH 0 with nothing staged flashes it. A USB side built without it (`bridgeFw` 0.0.0)
// gets the release's image staged first, checked against its identity block before a byte goes.
//
// The flash itself, its phases as steps, the retry note, a loss of contact and what each result
// leaves behind are every target's (uploader-run.ts). This owns what is node 0's: the bundle, a
// NOT_STAGED answer, the press-reset note after no answer, the cockpit's pause, and when its
// silence isn't "not responding" (it returns to its app by itself, Boot::IDLE_TIMEOUT_MS). A result
// lost with the USB side's power is judged from the node-0 row.
import type { LogEventInput } from '@shared/events'
import { GATEWAY_NODE_ID, NODE_KINDS, UPL_PROTO, UPL_TARGET } from '@shared/firmware'
import type { ReleaseTarget } from '@shared/releases'
import type { UpdateCheck, UpdateStepKey } from '@shared/update'
import { parseIdentity } from './firmware-image'
import type { FlowView, RunResult, StepReport, UpdateFlow } from './update-flow'
import { failed, FlashWatch, UploaderRun, type ReadImage } from './uploader-run'
import { UplRefused, type FlashEnd, type UploaderClient } from './uploader/uploader-client'

/** The cockpit side's rough time (FP07:459-462: 4.1 s from the bundle on the bench). */
export const COCKPIT_ESTIMATE_SEC = 5

const BUNDLE_STEPS: readonly UpdateStepKey[] = ['boot', 'write', 'verify', 'restart', 'ver']
const STAGE_STEPS: readonly UpdateStepKey[] = ['stage', ...BUNDLE_STEPS]

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
  private image?: ReadImage
  /** The last run ended with no answer from the board: a Retry says to press its reset button. */
  private pressReset = false
  /** The flash through the uploader, shared with every target. */
  private readonly session: UploaderRun

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
    this.session = new UploaderRun(uploader, ports, this.timing)
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
    return this.session.detachable()
  }

  /** Close while cut off: stop waiting; the cockpit's pause and the roster hold end with the run. */
  detach(): void {
    this.session.detach()
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
      (): RunResult => failed({ kind: 'no-answer' }, 0)
    )
    this.hooks.running(false)
    this.pressReset = !result.ok && result.failure.kind === 'no-response'
    // A flash that wrote nothing may leave it in its bootloader, which it leaves by itself.
    if (!result.ok && result.after === 'refused') this.hooks.settling()
    return result
  }

  // ── the run ────────────────────────────────────────────────────────────────

  private at(key: UpdateStepKey): number {
    return Math.max(0, this.steps().indexOf(key))
  }

  private async attempt(report: StepReport): Promise<RunResult> {
    const up = this.uploader
    const info = await up.info()
    if (!info) return failed({ kind: 'no-uploader' }, 0)
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

  /** UPL_FLASH 0 (the bundle, or what this run staged). */
  private flash(watch: FlashWatch): Promise<FlashEnd> {
    return this.session.flash(UPL_TARGET.bridge, UPL_TARGET.nodeIdKeep, watch)
  }

  /** UPL_FLASH refused: nothing started. */
  private refusedAtFlash(e: unknown): RunResult {
    if (e instanceof UplRefused && e.reason === 'BUSY') return failed({ kind: 'busy' }, 0)
    if (e instanceof UplRefused) return failed({ kind: 'no-answer' }, this.at('boot'))
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
    const r = await this.session.stage(
      this.image!,
      { nodeId: GATEWAY_NODE_ID, nodeKind: NODE_KINDS.BRIDGE, version: this.to },
      { kind: 'image', message: `The saved image of firmware ${this.to} is damaged.` },
      report
    )
    if (!r) this.ours = true
    return r
  }

  /** Until the flash's result: through any loss of contact, then what it means for node 0. */
  private async settle(end: FlashEnd, watch: FlashWatch, report: StepReport): Promise<RunResult> {
    const r = await this.session.settle(end, watch, report)
    // Closed meanwhile: the Gateway finishes on its own; nobody reads this result.
    if ('left' in r) return failed({ kind: 'no-answer' }, watch.furthest)
    if ('powerCycled' in r) return this.judgeFromRow(watch)
    return this.session.outcome(r.outcome, watch, this)
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
    if (version) return failed({ kind: 'interrupted' }, watch.furthest, 'refused')
    // No row: written into — or maybe, with statuses missed — it waits in its bootloader; else it
    // returns to its app by itself.
    return watch.mayBeErased
      ? failed({ kind: 'not-responding' }, watch.furthest, 'erased')
      : failed({ kind: 'interrupted' }, watch.furthest, 'refused')
  }
}
