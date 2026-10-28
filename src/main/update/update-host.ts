// The firmware update the client runs, one at a time, and the shared update dialog's state (#173):
// the confirm step's checks, the run's steps, a failure and Retry, the result. It pushes
// `update:state` after every change; the renderer only words it.
//
// A target supplies its own steps and run (the Gateway's USB side here; #187's cockpit side and
// #175's boards add theirs); the host owns what every update shares: the relay and link checks,
// *I understand*, one update at a time, Retry from where the failure says, and Close.
import type { Emit } from '@shared/app'
import type { ReleaseTarget } from '@shared/releases'
import type {
  UpdateCheck,
  UpdatePushChannels,
  UpdateState,
  UpdateStep,
  UpdateTargetRef
} from '@shared/update'
import {
  USB_ESTIMATE_SEC,
  USB_STEPS,
  UsbSideUpdate,
  type RunResult,
  type UsbSidePorts
} from './usb-side-update'

type Version = { major: number; minor: number; patch: number }

/** What the dialog reads from the rest of the app at each push. */
export interface UpdateHostDeps {
  /** The DCS relay is running. */
  relayRunning(): boolean
  /** The Gateway link is up. */
  linkUp(): boolean
  /** The Gateway's cockpit side's major, from its own row; undefined when it reports none. */
  cockpitMajor(): number | undefined
  /** The release the Firmware sheet compares with (releases' `target()`). */
  release(): ReleaseTarget | undefined
  /** Everything the USB side's update needs. */
  usb: UsbSidePorts
  /** Update drives mounted while the link is down changed (the Firmware sheet's row, NodeHub). */
  drivesChanged?(count: number): void
}

/**
 * How often update drives are looked for while the Gateway link is down: a folder read (macOS,
 * Linux) or a file check per drive letter (Windows), at the link's own retry pace.
 */
export const DRIVE_WATCH_MS = 5_000

const versionText = (v: Version) => `${v.major}.${v.minor}.${v.patch}`
const major = (v: string) => Number(v.split('.')[0])

export class UpdateHost {
  private open?: {
    target: UpdateTargetRef
    flow: UsbSideUpdate
    from?: string
    ack: boolean
    phase: UpdateState['phase']
    at: number
    pct: number
    /** Where Retry starts. */
    retryFrom: number
    result?: RunResult
    /** It waits in its update drive: the update starts at the copy. */
    inDrive: boolean
  }
  /** Update drives mounted while the link is down, as last looked for. */
  private drives = 0
  private watch?: ReturnType<typeof setInterval>
  /** The USB side's release from HELLO this connect: the dialog's "from". */
  private usbVersion?: string

  constructor(
    private readonly emit: Emit<keyof UpdatePushChannels>,
    private readonly deps: UpdateHostDeps
  ) {}

  /** HELLO answered on a connect, or didn't (hid/calibration's usbFirmware). */
  usbFirmware(fw: Version | undefined): void {
    this.usbVersion = fw && versionText(fw)
    this.open?.flow.helloAnswered(fw)
  }

  /** The relay, the link or the saved releases changed: the checks may have. */
  inputsChanged(): void {
    this.watchDrives()
    if (this.open?.phase === 'confirm' || this.open?.phase === 'done') this.push()
  }

  /** App quit: the drive watch stops. */
  dispose(): void {
    if (this.watch) clearInterval(this.watch)
    this.watch = undefined
  }

  /**
   * Look for update drives while the link is down and no update runs (#173): a Gateway left in its
   * drive (an interrupted copy, or BOOTSEL held) has no port, so this is the only way to see it.
   * Stops, and reports none, while the link is up.
   */
  private watchDrives(): void {
    const on = !this.deps.linkUp() && this.open?.phase !== 'run'
    if (on && !this.watch) {
      void this.lookForDrives()
      this.watch = setInterval(() => void this.lookForDrives(), DRIVE_WATCH_MS)
    } else if (!on && this.watch) {
      this.dispose()
      if (this.deps.linkUp()) this.setDrives(0)
    }
  }

  private async lookForDrives(): Promise<void> {
    const count = (await this.deps.usb.drive.list()).length
    if (this.watch) this.setDrives(count)
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
    const release = this.deps.release()
    const to = o.flow.to
    const checks: UpdateCheck[] = [
      { kind: 'relay', ok: !this.deps.relayRunning() },
      o.inDrive
        ? { kind: 'drive', ok: this.drives === 1 }
        : { kind: 'link', ok: this.deps.linkUp() },
      {
        kind: 'image',
        ok: !!release && release.version === to && release.hasImage({ side: 'usb' }),
        version: to
      }
    ]
    const cockpit = this.deps.cockpitMajor()
    const halves =
      cockpit !== undefined && cockpit !== major(to) ? { usb: major(to), cockpit } : undefined
    // From the drive the steps begin at the copy.
    const first = o.inDrive ? 1 : 0
    const steps = USB_STEPS.map(
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
        ...(key === 'copy' && n === o.at && o.phase === 'run' && { pct: o.pct })
      })
    ).slice(first)
    const r = o.result
    return {
      target: o.target,
      name: 'Gateway · USB side',
      ...(o.from && { from: o.from }),
      ...(o.inDrive && { inDrive: true as const }),
      to,
      phase: o.phase,
      checks,
      ...(halves && { halves }),
      ack: o.ack,
      canStart: checks.every((c) => c.ok) && (!halves || o.ack),
      estimateSec: USB_ESTIMATE_SEC,
      steps,
      pct:
        o.phase === 'done'
          ? 100
          : o.phase === 'confirm'
            ? 0
            : Math.round(
                ((o.at - first + (USB_STEPS[o.at] === 'copy' ? o.pct / 100 : 0)) /
                  (USB_STEPS.length - first)) *
                  100
              ),
      ...(r && !r.ok && o.phase === 'fail' && { failure: r.failure }),
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
    const release = this.deps.release()
    if (!release) return
    // No port, but an update drive is mounted: the Gateway waits in it, and the update starts at
    // the copy (#173 Update step 3).
    const inDrive = !this.deps.linkUp() && this.drives > 0
    this.open = {
      target,
      flow: new UsbSideUpdate(release.version, this.deps.usb),
      ...(!inDrive && this.usbVersion && { from: this.usbVersion }),
      ack: false,
      phase: 'confirm',
      at: inDrive ? 1 : 0,
      pct: 0,
      retryFrom: inDrive ? 1 : 0,
      inDrive
    }
    this.push()
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
    await this.run(this.open.retryFrom)
  }

  /** Close the dialog; never while it runs. */
  close(): void {
    if (!this.open || this.open.phase === 'run') return
    // A failure may have left the port taken: the link looks for the Gateway again.
    if (this.open.phase === 'fail') this.open.flow.close()
    this.open = undefined
    this.push()
  }

  // ── the run ────────────────────────────────────────────────────────────────

  private async run(from: number): Promise<void> {
    const o = this.open!
    Object.assign(o, { phase: 'run', at: from, pct: 0, result: undefined })
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
      }
    })
    o.result = result
    if (result.ok) {
      o.phase = 'done'
      o.at = USB_STEPS.length - 1
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
