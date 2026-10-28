// Updating the Gateway's USB side from a saved release (#173): the image from the release cache,
// the 1200-baud touch into the UF2 drive, the copy, the reconnect, and the version it reports.
// The Gateway's axis calibration is put back with no prompt if the update cleared it.
//
// Every outside thing is a port app hands in: the link, the drive, the image, calibration and the
// event log. The steps run in order; a failure says which step Retry may safely start from
// (#173 Failures): nothing written → the touch again; the copy → the copy again; no reconnect →
// look again (or copy again while the drive is still there); the wrong version → never on its own.
import type { LogEventInput } from '@shared/events'
import type { CalSnapshot } from '@shared/hid/calibration'
import type { UpdateCalibration, UpdateFailure, UpdateStepKey } from '@shared/update'
import type { Uf2Drive } from './uf2-drive'

/** What the flow needs from the rest of the app. */
export interface UsbSidePorts {
  link: {
    /** Take the port from the link (released before this resolves); the board's path, if any. */
    take(): Promise<string | undefined>
    /** The 1200-baud touch on `path`. */
    touch(path: string): Promise<void>
    /** Give the port back: the link looks for the board again. */
    handBack(): void
    /** A Gateway serial port enumerates now: the Gateway runs, so no update drive is its. */
    present(): Promise<boolean>
  }
  drive: Uf2Drive
  /** The USB side's image of `version` from the release cache (#192 getFile, SHA-256 checked). */
  image(
    version: string
  ): Promise<{ ok: true; bytes: Uint8Array; name: string } | { ok: false; message: string }>
  calibration: {
    /** What the Gateway reported holding at its last connect (HidCalibrationService). */
    snapshot(): CalSnapshot | undefined
    /** The saved copy's axes the Gateway now reports present but uncalibrated (regressedAxes). */
    regressed(): number[]
    /** This computer has a saved copy of every one of `axes` for this Gateway. */
    hasCopy(axes: number[]): boolean
    /** Write the saved copy back for `axes`; true when every axis stored. */
    restore(axes: number[]): Promise<boolean>
  }
  events: (rows: LogEventInput[]) => void
  now: () => number
  timing?: Partial<UsbSideTiming>
}

/** How long each wait lasts: the client's own figures, from the bench (OpenSkyhawk#361). */
export interface UsbSideTiming {
  /** For the drive after the touch (it took 1.7 s on the bench). */
  driveMs: number
  /** For the Gateway's HELLO after the copy (the port was back in 2 s). */
  reconnectMs: number
  /** For its calibration read after HELLO (DIAG may time out first, 2 s, on older firmware). */
  calMs: number
  /** How often the drive and the calibration read are looked for. */
  pollMs: number
}

const TIMING: UsbSideTiming = { driveMs: 10_000, reconnectMs: 20_000, calMs: 6_000, pollMs: 250 }

/** The dialog's steps for the USB side (CockpitMap.dc.html:910). */
export const USB_STEPS: readonly UpdateStepKey[] = ['uf2', 'copy', 'rec', 'ver']

/** The USB side's rough time, for the confirm step (#361: about 5 s in all). */
export const USB_ESTIMATE_SEC = 5

/** Told as the run goes: a step starts, the copy's progress. */
export interface StepReport {
  step(index: number): void
  pct(n: number): void
}

export type RunResult =
  | { ok: true; reports: string; calibration?: UpdateCalibration }
  | { ok: false; failure: UpdateFailure; at: number; retryFrom: number }

const text = (v: { major: number; minor: number; patch: number }) =>
  `${v.major}.${v.minor}.${v.patch}`

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class UsbSideUpdate {
  private readonly timing: UsbSideTiming
  private image?: { bytes: Uint8Array; name: string }
  /** Calibration as the Gateway reported it before anything happened; read once, at the first run. */
  private calBefore?: CalSnapshot
  private started = false
  private hello?: (version: string | undefined) => void
  /**
   * The release the Gateway reported in its last HELLO since this run took the port: kept even
   * with nothing waiting, so a Retry after a late reconnect needn't wait for a HELLO that already
   * came. Cleared whenever the port is taken.
   */
  private lastHello?: string
  /** This run took the port from the link (and owes it back if the dialog closes on a failure). */
  private took = false
  /** The Gateway's update drive, once one appeared for it. */
  private root?: string
  /**
   * Update drives already mounted when this run touched the Gateway: other RP2040s in BOOTSEL,
   * which must never receive its firmware.
   */
  private strays: string[] = []

  constructor(
    readonly to: string,
    private readonly ports: UsbSidePorts
  ) {
    this.timing = { ...TIMING, ...ports.timing }
  }

  /**
   * HELLO on a connect (hid/calibration reads it once per port open): its release, or undefined
   * when it went unanswered.
   */
  helloAnswered(fw: { major: number; minor: number; patch: number } | undefined): void {
    if (fw) this.lastHello = text(fw)
    this.hello?.(fw && text(fw))
  }

  /** Run from step `from`; resolves with the result or the failure and where Retry may restart. */
  async run(from: number, report: StepReport): Promise<RunResult> {
    const fail = (failure: UpdateFailure, at: number, retryFrom: number): RunResult => ({
      ok: false,
      failure,
      at,
      retryFrom
    })
    if (!this.started) {
      // Before the port is released: releasing it clears what calibration last read (#173).
      this.calBefore = this.ports.calibration.snapshot()
      this.started = true
    }
    if (!this.image) {
      const img = await this.ports.image(this.to)
      if (!img.ok) return fail({ kind: 'image', message: img.message }, from, from)
      this.image = { bytes: img.bytes, name: img.name }
    }

    let reported: string | undefined
    for (let at = from; at < USB_STEPS.length; at++) {
      report.step(at)
      switch (USB_STEPS[at]) {
        case 'uf2': {
          // Take the port first: every RP2040 in BOOTSEL mounts the same drive, so the Gateway's
          // is the one that appears after its own touch, never one already there.
          const path = await this.ports.link.take()
          this.took = true
          this.lastHello = undefined
          this.root = undefined
          if (path) {
            this.strays = await this.ports.drive.list()
            await this.ports.link.touch(path).catch(() => {})
          } else {
            // No Gateway port: a blank Gateway, or one plugged in holding BOOTSEL. Its drive is
            // the one mounted now — unless there are several, and no telling which.
            this.strays = []
            if ((await this.ports.drive.list()).length > 1) {
              return fail({ kind: 'many-drives' }, at, at)
            }
          }
          this.root = await this.waitForDrive()
          if (!this.root) return fail({ kind: 'no-drive' }, at, at)
          break
        }
        case 'copy': {
          // Only a HELLO after this copy says what it runs now.
          this.lastHello = undefined
          if (!this.root) {
            // Started here (the Gateway waits in its drive): a Gateway running as a port has left
            // it, and any drive mounted now is another board's. Never guess between several.
            if (await this.ports.link.present()) return fail({ kind: 'left-drive' }, at, at)
            if ((await this.ports.drive.list()).length > 1) {
              return fail({ kind: 'many-drives' }, at, at)
            }
          }
          // After a failed copy the drive may come back only through BOOTSEL: wait for it again.
          const root = await this.waitForDrive()
          this.root = root
          const img = this.image
          const ok =
            !!root &&
            (await this.ports.drive.write(root, img.name, img.bytes, (n) => report.pct(n)))
          if (!ok) return fail({ kind: 'copy-failed' }, at, at)
          break
        }
        case 'rec': {
          reported = await this.reconnect()
          if (reported) break
          // Still in its update drive: the copy didn't take, so Retry copies again.
          const stillDrive = !!this.root && (await this.ports.drive.list()).includes(this.root)
          return fail({ kind: 'no-reconnect' }, at, stillDrive ? at - 1 : at)
        }
        case 'ver':
          if (reported !== this.to) {
            return fail({ kind: 'wrong-version', reported: reported ?? '' }, at, 0)
          }
          break
      }
    }
    const calibration = await this.calibration()
    return { ok: true, reports: reported!, ...(calibration && { calibration }) }
  }

  /**
   * The dialog closed (#173): if a failure left the port taken — no drive, or a failed copy — the
   * link gets it back and looks for the Gateway again. A run that never took it (one started from
   * the update drive) leaves the link as the user set it.
   */
  close(): void {
    if (this.took) this.ports.link.handBack()
  }

  /**
   * The Gateway's drive, as soon as it is there, or undefined after `driveMs`: the one it used
   * before if that is still mounted, else one that wasn't mounted when this run touched it.
   */
  private async waitForDrive(): Promise<string | undefined> {
    const end = this.ports.now() + this.timing.driveMs
    for (;;) {
      const mounted = await this.ports.drive.list()
      const root =
        this.root && mounted.includes(this.root)
          ? this.root
          : mounted.find((d) => !this.strays.includes(d))
      if (root || this.ports.now() >= end) return root
      await sleep(this.timing.pollMs)
    }
  }

  /**
   * Give the port back — or, from the update drive, start the link looking even if it was
   * disconnected — and wait for the Gateway's HELLO: its version, or undefined.
   */
  private reconnect(): Promise<string | undefined> {
    // It came back after an earlier wait gave up (Retry): its HELLO is already in.
    if (this.lastHello) {
      this.ports.link.handBack()
      return Promise.resolve(this.lastHello)
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(undefined), this.timing.reconnectMs)
      const done = (v: string | undefined) => {
        clearTimeout(timer)
        this.hello = undefined
        resolve(v)
      }
      this.hello = done
      this.ports.link.handBack()
    })
  }

  /**
   * The Gateway's calibration after the update (#173 Calibration): cleared if an axis that was
   * present and calibrated before isn't calibrated now. With no before-reading (it failed, or the
   * update began at the drive), the owner's own check: the saved axes it now reports uncalibrated.
   * Cleared, with a saved copy → written back with no prompt, one event row.
   */
  private async calibration(): Promise<UpdateCalibration | undefined> {
    const after = await this.waitForCalibration()
    if (!after) return undefined
    const before = this.calBefore
    const cleared = before
      ? before.axes
          .filter((a) => a.present && a.calibrated && !after.axes[a.idx]?.calibrated)
          .map((a) => a.idx)
      : this.ports.calibration.regressed()
    if (!cleared.length) return undefined
    if (!this.ports.calibration.hasCopy(cleared)) return 'cleared-no-copy'
    const ok = await this.ports.calibration.restore(cleared)
    const axes = cleared.length === 1 ? '1 axis' : `${cleared.length} axes`
    this.ports.events([
      {
        t: this.ports.now(),
        source: 'client',
        name: 'Gateway',
        severity: ok ? 'info' : 'error',
        event: ok ? 'calibration restored' : 'calibration not restored',
        detail: ok
          ? `${axes}, from this computer's copy, after the firmware update`
          : `${axes} cleared by the firmware update; writing this computer's copy back failed`,
        raw: ''
      }
    ])
    return ok ? 'restored' : 'restore-failed'
  }

  /** What the Gateway reports holding after it reconnects, or undefined after `calMs`. */
  private async waitForCalibration(): Promise<CalSnapshot | undefined> {
    const end = this.ports.now() + this.timing.calMs
    for (;;) {
      const snap = this.ports.calibration.snapshot()
      if (snap || this.ports.now() >= end) return snap
      await sleep(this.timing.pollMs)
    }
  }
}
