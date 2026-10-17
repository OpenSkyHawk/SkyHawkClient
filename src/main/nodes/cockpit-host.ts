// The Cockpit snapshot as the app runs it (R3.2): what the renderer kept and re-rendered on before
// the move, mirrored here so `cockpit:snapshot` goes out at the same moments with the same inputs.
//   - The renderer's store held the last pushed model and telemetry, and the session's peak W
//     (setNodes: each push, and the renderer's first pull, raise it); a reload started it over.
//   - The Cockpit re-rendered on each of those pushes and on `device:status`, and its stray timer
//     re-rendered it `nextAt` + 50 ms after a board still identifying was due. Its clock for the
//     strays (its `now` state) moved only then: a push in between was judged at the old time.
// NodeHub hosts one; the component tests' mock hosts one over the scenario, so the Cockpit under
// test draws what this pushes.
import type { DeviceStatus } from '@shared/gateway'
import {
  COCKPIT_IDLE,
  type CockpitSnapshot,
  type NodeModel,
  type NodeTelemSnapshot
} from '@shared/nodes'
import { buildCockpitSnapshot, sessionPeakW } from './cockpit-snapshot'

/** The renderer's stray timer fired this long after `nextAt` (Cockpit.tsx before R3.2). */
export const STRAY_RECHECK_MS = 50

export interface CockpitTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

/** The global timers, looked up at each call (so a test's fake timers apply). */
const SYSTEM_TIMERS: CockpitTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>)
}

/** What the snapshot reads at build time besides the pushes it is handed. */
export interface CockpitSource {
  /** The link as last pushed on `device:status`, the Gateway's health included. */
  device(): DeviceStatus
}

export interface CockpitHostOptions {
  now?: () => number
  timers?: CockpitTimers
}

export class CockpitSnapshotHost {
  private model?: NodeModel
  private telemetry: NodeTelemSnapshot[] = []
  private peakW = 0
  private rev = 0
  private current: CockpitSnapshot = COCKPIT_IDLE
  /** The `nextAt` the stray timer is set for (React's effect dependency before R3.2). */
  private strayAt?: number
  /**
   * The time strays are judged at: the first snapshot's, a renderer load's, then each time the stray
   * timer fires (the Cockpit's `now`, which only its timer moved).
   */
  private strayClock?: number
  private strayTimer?: unknown
  private readonly now: () => number
  private readonly timers: CockpitTimers

  constructor(
    private readonly push: (snapshot: CockpitSnapshot) => void,
    private readonly source: CockpitSource,
    opts: CockpitHostOptions = {}
  ) {
    this.now = opts.now ?? (() => Date.now())
    this.timers = opts.timers ?? SYSTEM_TIMERS
  }

  /** `nodes:model` goes out (NodeHub calls this just before it). */
  modelPushed(model: NodeModel): void {
    this.model = model
    this.peakW = sessionPeakW(this.peakW, model, this.telemetry)
    this.publish()
  }

  /** `nodes:telemetry` goes out (NodeHub calls this just before it). */
  telemetryPushed(telemetry: NodeTelemSnapshot[]): void {
    this.telemetry = telemetry
    this.peakW = sessionPeakW(this.peakW, this.model, telemetry)
    this.publish()
  }

  /** `device:status` went out: the link's state or the Gateway's health changed. */
  linkChanged(): void {
    this.publish()
  }

  /**
   * A renderer (re)loaded (`relay:status`, its first pull): its store starts over from what main
   * holds now — the model and telemetry its `nodes:get` read — and its peak with them.
   */
  rendererLoaded(model: NodeModel, telemetry: NodeTelemSnapshot[]): void {
    this.model = model
    this.telemetry = telemetry
    this.peakW = sessionPeakW(0, model, telemetry)
    this.strayClock = this.now()
    this.publish()
  }

  /** The last snapshot pushed. */
  state(): CockpitSnapshot {
    return this.current
  }

  /** Stop the stray timer (shutdown). */
  dispose(): void {
    if (this.strayTimer !== undefined) this.timers.clearTimeout(this.strayTimer)
    this.strayTimer = undefined
    this.strayAt = undefined
  }

  private publish(): void {
    this.strayClock ??= this.now()
    const { snapshot, nextAt } = buildCockpitSnapshot({
      model: this.model,
      telemetry: this.telemetry,
      device: this.source.device(),
      peakW: this.peakW,
      now: this.strayClock,
      rev: ++this.rev
    })
    this.current = snapshot
    this.push(snapshot)
    this.schedule(nextAt)
  }

  /** A new `nextAt`: the old timer goes, and one is set for it — as the renderer's effect did. */
  private schedule(nextAt: number | undefined): void {
    if (nextAt === this.strayAt) return
    if (this.strayTimer !== undefined) this.timers.clearTimeout(this.strayTimer)
    this.strayTimer = undefined
    this.strayAt = nextAt
    if (nextAt === undefined) return
    this.strayTimer = this.timers.setTimeout(
      () => {
        this.strayTimer = undefined
        this.strayClock = this.now()
        this.publish()
      },
      Math.max(0, nextAt - this.now()) + STRAY_RECHECK_MS
    )
  }
}
