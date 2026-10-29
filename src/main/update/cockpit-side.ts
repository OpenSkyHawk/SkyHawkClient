// The Gateway's cockpit side, as the update topic knows it (#187): what its USB side's uploader
// said on this connect (whether it has one, the bundled cockpit-side version), whether an update of
// it runs, and whether its silence is expected (it returns to its app by itself after a refused
// update). Main pushes this to nodes, which shows the Firmware row, pauses the cockpit and holds the
// roster; the "not responding" rule itself is the Gateway's health (gateway-health), which asks
// `probe()` whether the USB side still answers.
import { BOOT } from '@shared/firmware'
import type { ReleaseTarget } from '@shared/releases'
import {
  CockpitSideUpdate,
  type CockpitSidePorts,
  type CockpitSideTiming
} from './cockpit-side-update'
import {
  UploaderClient,
  type UplLog,
  type UploaderLink,
  type UploaderTiming
} from './uploader/uploader-client'
import type { UplInfo } from './uploader/upl-codec'

/** What nodes shows about the cockpit side, pushed on every change. */
export interface CockpitSideState {
  /** The USB side answered UPL_INFO this connect: it has the uploader (0.3.0 and newer). */
  uploader: boolean
  /** The cockpit-side version its firmware carries (#367); absent: none (a dev build). */
  bundled?: string
  /** An update of the cockpit side runs: the cockpit pauses, the roster holds. */
  updating?: { from?: string; to: string }
  /** Its silence is expected now (an update runs, or it returns to its app): not news. */
  quiet: boolean
}

export interface CockpitSideDeps extends CockpitSidePorts {
  link: UploaderLink
  /** The cockpit side doesn't respond now (the Gateway's health says so). */
  notResponding(): boolean
  publish(state: CockpitSideState): void
  timing?: Partial<CockpitSideTiming>
  uploaderTiming?: Partial<UploaderTiming>
  /** The debug log: the uploader's requests, statuses and result. */
  log?: UplLog
}

export class CockpitSide {
  readonly uploader: UploaderClient
  /** UPL_INFO on this connect: undefined until read, null when nothing answered. */
  private info?: UplInfo | null
  private usb?: string
  private updating?: { from?: string; to: string }
  private settleTimer?: ReturnType<typeof setTimeout>
  private last = ''
  /** Rises with each connect: a read that lands after the link went is dropped. */
  private connect = 0

  constructor(private readonly deps: CockpitSideDeps) {
    this.uploader = new UploaderClient(deps.link, deps.uploaderTiming, deps.log)
  }

  /** HELLO answered on a connect (the USB side's release), or didn't: read UPL_INFO after it. */
  connected(usb: string | undefined): void {
    const n = ++this.connect
    this.usb = usb
    this.info = undefined
    if (!usb) {
      this.info = null
      this.publish()
      return
    }
    void this.uploader.info().then(
      (info) => {
        if (n !== this.connect) return
        this.info = info ?? null
        this.publish()
      },
      () => {
        if (n === this.connect) this.info = null
      }
    )
  }

  /** The link went: nothing is known about this Gateway's uploader until the next connect. */
  linkDown(): void {
    this.connect++
    if (this.info === undefined && this.usb === undefined) return
    this.info = undefined
    this.usb = undefined
    this.publish()
  }

  /** The USB side answers UPL_INFO now (gateway-health asks, when the roster went silent). */
  async probe(): Promise<boolean> {
    if (!this.info) return false
    return (await this.uploader.info().catch(() => undefined)) !== undefined
  }

  /**
   * The cockpit side's update for the dialog, at the bundle's version or else the saved release's;
   * undefined with neither, or before the connect read answered.
   */
  flow(release: ReleaseTarget | undefined): CockpitSideUpdate | undefined {
    const info = this.info
    const bundled = info?.bridgeFw
    const to = bundled ?? release?.version
    if (!to) return undefined
    return new CockpitSideUpdate(
      {
        to,
        bundle: !!bundled,
        ...(release && { release }),
        ...(this.usb && { usb: this.usb }),
        notResponding: this.deps.notResponding(),
        uploader: () => !!this.info
      },
      this.uploader,
      this.deps,
      {
        running: (on) => {
          this.updating = on ? { ...(this.from() && { from: this.from() }), to } : undefined
          if (on) this.settled()
          this.publish()
        },
        settling: () => this.settling()
      },
      this.deps.timing
    )
  }

  private from(): string | undefined {
    return this.deps.notResponding() ? undefined : this.deps.bridgeVersion()
  }

  /**
   * Nothing was written, but the cockpit side may wait in its bootloader: it goes back to its app
   * within Boot::IDLE_TIMEOUT_MS, so its silence until then is expected.
   */
  private settling(): void {
    this.settled()
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined
      this.publish()
    }, BOOT.idleTimeoutMs)
    this.publish()
  }

  private settled(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = undefined
  }

  /** App quit. */
  dispose(): void {
    this.settled()
  }

  state(): CockpitSideState {
    const bundled = this.info?.bridgeFw
    return {
      uploader: !!this.info,
      ...(bundled && { bundled }),
      ...(this.updating && { updating: this.updating }),
      quiet: !!this.updating || !!this.settleTimer
    }
  }

  private publish(): void {
    const s = this.state()
    const key = JSON.stringify(s)
    if (key === this.last) return
    this.last = key
    this.deps.publish(s)
  }
}
