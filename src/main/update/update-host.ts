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
}

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
  }
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
    if (this.open?.phase === 'confirm' || this.open?.phase === 'done') this.push()
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
      { kind: 'link', ok: this.deps.linkUp() },
      {
        kind: 'image',
        ok: !!release && release.version === to && release.hasImage({ side: 'usb' }),
        version: to
      }
    ]
    const cockpit = this.deps.cockpitMajor()
    const halves =
      cockpit !== undefined && cockpit !== major(to) ? { usb: major(to), cockpit } : undefined
    const steps: UpdateStep[] = USB_STEPS.map((key, n) => ({
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
    }))
    const r = o.result
    return {
      target: o.target,
      name: 'Gateway · USB side',
      ...(o.from && { from: o.from }),
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
                ((o.at + (USB_STEPS[o.at] === 'copy' ? o.pct / 100 : 0)) / USB_STEPS.length) * 100
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
    this.open = {
      target,
      flow: new UsbSideUpdate(release.version, this.deps.usb),
      ...(this.usbVersion && { from: this.usbVersion }),
      ack: false,
      phase: 'confirm',
      at: 0,
      pct: 0,
      retryFrom: 0
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
    await this.run(0)
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
    this.push()
  }

  private push(): void {
    this.emit('update:state', this.state())
  }
}
