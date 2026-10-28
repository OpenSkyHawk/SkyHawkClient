// The firmware update the client runs, one at a time, and the shared update dialog's state (#173):
// the confirm step's checks, the run's steps, a failure and Retry, the result. It pushes
// `update:state` after every change; the renderer only words it.
//
// A target supplies its own steps, checks and run (update-flow.ts: the Gateway's USB side, #173,
// and its cockpit side, #187; #175's boards add theirs); the host owns what every update shares:
// the relay check, *I understand*, one update at a time, the phase and the progress, Retry from
// where the failure says, and Close. The USB side's drive watch stays here too: it runs while no
// update does.
import type { Emit } from '@shared/app'
import type { ReleaseTarget } from '@shared/releases'
import type {
  UpdateCheck,
  UpdateNote,
  UpdatePushChannels,
  UpdateState,
  UpdateStep,
  UpdateStepKey,
  UpdateTargetRef
} from '@shared/update'
import { CockpitSide, type CockpitSideDeps } from './cockpit-side'
import type { RunResult, UpdateFlow } from './update-flow'
import { UsbSideUpdate, type UsbSidePorts } from './usb-side-update'

type Version = { major: number; minor: number; patch: number }

/** The steps whose progress fills the bar between them: a copy, staging, writing. */
const PCT_STEPS: ReadonlySet<UpdateStepKey> = new Set(['copy', 'stage', 'write'])

/** What the dialog reads from the rest of the app at each push. */
export interface UpdateHostDeps {
  /** The DCS relay is running. */
  relayRunning(): boolean
  /** The Gateway link is up. */
  linkUp(): boolean
  /** A Gateway serial port enumerates now, open or not (gateway's `gatewayPresent`). */
  gatewayPresent(): Promise<boolean>
  /** The Gateway's cockpit side's major, from its own row; undefined when it reports none. */
  cockpitMajor(): number | undefined
  /** The release the Firmware sheet compares with (releases' `target()`). */
  release(): ReleaseTarget | undefined
  /** Everything the USB side's update needs. */
  usb: UsbSidePorts
  /** Everything the cockpit side's needs (#187); none: no cockpit-side updates. */
  cockpit?: CockpitSideDeps
  /** Update drives mounted while the link is down changed (the Firmware sheet's row, NodeHub). */
  drivesChanged?(count: number): void
}

/**
 * How often update drives are looked for while the Gateway link is down: a folder read (macOS,
 * Linux) or a file check per drive letter (Windows), at the link's own retry pace.
 */
export const DRIVE_WATCH_MS = 5_000

const versionText = (v: Version) => `${v.major}.${v.minor}.${v.patch}`

export class UpdateHost {
  /** The Gateway's cockpit side as the uploader reported it this connect (#187). */
  readonly cockpit?: CockpitSide
  private open?: {
    flow: UpdateFlow
    ack: boolean
    phase: UpdateState['phase']
    at: number
    pct: number
    note?: UpdateNote
    /** Where Retry starts. */
    retryFrom: number
    result?: RunResult
  }
  /** Update drives mounted while the link is down, as last looked for. */
  private drives = 0
  private watch?: ReturnType<typeof setInterval>
  /** A look is in flight: a slow drive (a dead network share on Windows) never stacks them. */
  private looking = false
  /** The USB side's release from HELLO this connect: the dialog's "from". */
  private usbVersion?: string

  constructor(
    private readonly emit: Emit<keyof UpdatePushChannels>,
    private readonly deps: UpdateHostDeps
  ) {
    if (deps.cockpit) this.cockpit = new CockpitSide(deps.cockpit)
  }

  /** HELLO answered on a connect, or didn't (hid/calibration's usbFirmware). */
  usbFirmware(fw: Version | undefined): void {
    this.usbVersion = fw && versionText(fw)
    const flow = this.open?.flow
    if (flow instanceof UsbSideUpdate) flow.helloAnswered(fw)
  }

  /**
   * The connect's calibration read is over (hid/calibration's connectRead): the cockpit side's
   * uploader is read next, once per connect (#187).
   */
  connectRead(): void {
    this.cockpit?.connected(this.usbVersion)
  }

  /**
   * The relay, the link, a calibration session or the saved releases changed: the checks may
   * have.
   */
  inputsChanged(): void {
    this.watchDrives()
    if (!this.deps.linkUp()) this.cockpit?.linkDown()
    // The Gateway came back as a port while the dialog waited to copy to its drive: that update no
    // longer applies; its row offers the ordinary one.
    if (this.open?.flow.view().inDrive && this.open.phase === 'confirm' && this.deps.linkUp()) {
      this.open = undefined
      this.push()
      return
    }
    if (this.open?.phase === 'confirm' || this.open?.phase === 'done') this.push()
  }

  /** App quit: the drive watch stops. */
  dispose(): void {
    if (this.watch) clearInterval(this.watch)
    this.watch = undefined
    this.cockpit?.dispose()
  }

  /**
   * Look for update drives while the link is down and no update runs (#173): a Gateway left in its
   * drive (an interrupted copy, or BOOTSEL held) has no port, so this is the only way to see it.
   * Stops, and reports none, while the link is up.
   */
  private watchDrives(): void {
    // A run cut off from its Gateway looks too: it may come back in its update drive (#187).
    const o = this.open
    const on = !this.deps.linkUp() && (o?.phase !== 'run' || !!o.flow.detachable?.())
    if (on && !this.watch) {
      void this.lookForDrives()
      this.watch = setInterval(() => void this.lookForDrives(), DRIVE_WATCH_MS)
    } else if (!on && this.watch) {
      this.dispose()
      if (this.deps.linkUp()) this.setDrives(0)
    }
  }

  /**
   * One look: none while a Gateway port enumerates (the Gateway runs, so a drive is another
   * RP2040's — and no drive scan at all), else the update drives mounted now.
   */
  private async lookForDrives(): Promise<void> {
    if (this.looking) return
    this.looking = true
    try {
      const count = (await this.deps.gatewayPresent())
        ? 0
        : (await this.deps.usb.drive.list()).length
      if (this.watch) this.setDrives(count)
    } finally {
      this.looking = false
    }
  }

  private setDrives(count: number): void {
    if (count === this.drives) return
    this.drives = count
    this.deps.drivesChanged?.(count)
    if (this.open?.phase === 'confirm') this.push()
  }

  // ── intents ────────────────────────────────────────────────────────────────

  /** `update:get`: the dialog as it stands. */
  state(): UpdateState | null {
    const o = this.open
    if (!o) return null
    const flow = o.flow
    const checks: UpdateCheck[] = [
      { kind: 'relay', ok: !this.deps.relayRunning() },
      ...flow.checks()
    ]
    const view = flow.view()
    const keys = flow.steps()
    // Steps before the first aren't listed (the USB side, from its drive).
    const first = flow.first()
    const steps = keys
      .map(
        (key, n): UpdateStep => ({
          key,
          state:
            o.phase === 'confirm' || n > o.at
              ? 'waiting'
              : n < o.at || o.phase === 'done'
                ? 'done'
                : o.phase === 'fail'
                  ? 'bad'
                  : 'on',
          ...(PCT_STEPS.has(key) && n === o.at && o.phase === 'run' && { pct: o.pct })
        })
      )
      .slice(first)
    const r = o.result
    return {
      target: flow.target,
      name: flow.name,
      ...view,
      to: flow.to,
      phase: o.phase,
      checks,
      ack: o.ack,
      canStart: checks.every((c) => c.ok) && (!view.halves || o.ack),
      estimateSec: flow.estimateSec,
      steps,
      pct:
        o.phase === 'done'
          ? 100
          : o.phase === 'confirm'
            ? 0
            : Math.round(
                ((o.at - first + (PCT_STEPS.has(keys[o.at]!) ? o.pct / 100 : 0)) /
                  (keys.length - first)) *
                  100
              ),
      ...(o.note && o.phase === 'run' && { note: o.note }),
      ...(o.phase === 'run' && flow.detachable?.() && { closable: true as const }),
      ...(r && !r.ok && o.phase === 'fail' && { failure: r.failure }),
      ...(r && !r.ok && o.phase === 'fail' && r.after && { after: r.after }),
      ...(r?.ok && {
        done: { reports: r.reports, ...(r.calibration && { calibration: r.calibration }) }
      }),
      relayRunning: this.deps.relayRunning()
    }
  }

  /**
   * Open the confirm step for `target` at the release the sheet compares with. Refused while an
   * update runs, or with no saved release to install.
   */
  openUpdate(target: UpdateTargetRef): void {
    if (this.open?.phase === 'run') return
    const flow = target.kind === 'cockpit' ? this.cockpitFlow() : this.usbFlow()
    if (!flow) return
    this.open = {
      flow,
      ack: false,
      phase: 'confirm',
      at: flow.first(),
      pct: 0,
      retryFrom: flow.first()
    }
    this.push()
    // What the confirm step reads first (a saved image's identity), pushed when it is in.
    const opened = this.open
    void flow.prepare?.().then(() => {
      if (this.open === opened && opened.phase === 'confirm') this.push()
    })
  }

  /**
   * The USB side's update to the release the sheet compares with: none with nothing saved. No
   * port, but an update drive is mounted: the Gateway waits in it, and the update starts at the
   * copy (#173 Update step 3).
   */
  private usbFlow(): UpdateFlow | undefined {
    const release = this.deps.release()
    if (!release) return undefined
    const inDrive = !this.deps.linkUp() && this.drives > 0
    return new UsbSideUpdate(release.version, this.deps.usb, {
      inDrive,
      ...(!inDrive && this.usbVersion && { from: this.usbVersion }),
      linkUp: () => this.deps.linkUp(),
      drives: () => this.drives,
      release: () => this.deps.release(),
      cockpitMajor: () => this.deps.cockpitMajor()
    })
  }

  /** The cockpit side's update (#187): to the bundle, else the saved release. */
  private cockpitFlow(): UpdateFlow | undefined {
    return this.cockpit?.flow(this.deps.release())
  }

  ack(on: boolean): void {
    if (this.open?.phase !== 'confirm') return
    this.open.ack = on
    this.push()
  }

  /** Start: only from the confirm step, with every check passing. */
  async start(): Promise<void> {
    if (this.open?.phase !== 'confirm' || !this.state()?.canStart) return
    await this.run(this.open.retryFrom)
  }

  /** Retry a failure from where it said Retry may start. */
  async retry(): Promise<void> {
    if (this.open?.phase !== 'fail') return
    // From the drive the update never restarts the Gateway: Retry starts at the copy at the latest.
    await this.run(Math.max(this.open.retryFrom, this.open.flow.first()))
  }

  /**
   * Close the dialog; never while it runs — except while the run waits for a Gateway it lost
   * (#187): then the run is left to the Gateway, which finishes on its own.
   */
  close(): void {
    const o = this.open
    if (!o) return
    if (o.phase === 'run') {
      if (!o.flow.detachable?.()) return
      o.flow.detach?.()
      this.open = undefined
      this.watchDrives()
      this.push()
      return
    }
    // What the run held goes back: the port after a failure (USB side), the staged image (#187).
    o.flow.close(o.phase)
    this.open = undefined
    this.push()
  }

  // ── the run ────────────────────────────────────────────────────────────────

  private async run(from: number): Promise<void> {
    const o = this.open!
    Object.assign(o, { phase: 'run', at: from, pct: 0, note: undefined, result: undefined })
    this.watchDrives() // the run looks for its own drive
    this.push()
    const result = await o.flow.run(from, {
      step: (n) => {
        o.at = n
        o.pct = 0
        this.push()
      },
      pct: (n) => {
        if (n === o.pct) return
        o.pct = n
        this.push()
      },
      note: (note) => {
        o.note = note
        this.watchDrives()
        this.push()
      }
    })
    // Closed while cut off (#187): nobody waits for this result.
    if (this.open !== o) return
    o.result = result
    if (result.ok) {
      o.phase = 'done'
      o.at = o.flow.steps().length - 1
    } else {
      o.phase = 'fail'
      o.at = result.at
      o.retryFrom = result.retryFrom
    }
    this.watchDrives()
    this.push()
  }

  private push(): void {
    this.emit('update:state', this.state())
  }
}
