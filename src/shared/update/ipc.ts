// Update topic contract (#173): the one firmware update the client runs at a time, and the shared
// update dialog that shows it. Imported by main, preload and the renderer.
//
// Main decides every state: the checks, each step, the failure and the result. The renderer only
// words them, by key. #173 brought the Gateway's USB side, #187 its cockpit side; the boards (#175)
// add their own targets, steps and failures here.
//
// Versions travel as `x.y.z` text, never as a release tag.

/** What an update is for: the Gateway's USB side (#173) or its cockpit side, node 0 (#187). */
export type UpdateTargetRef = { kind: 'usb' } | { kind: 'cockpit' }

/** Where the dialog is: the confirm step, the run, a failure, or the result. */
export type UpdatePhase = 'confirm' | 'run' | 'fail' | 'done'

/** A confirm-step check: passed, or blocking the start until the user fixes it. */
export type UpdateCheck =
  /** The DCS relay is stopped (*Stop relay* when it isn't): updates need the sim idle. */
  | { kind: 'relay'; ok: boolean }
  /** The Gateway is connected. */
  | { kind: 'link'; ok: boolean }
  /**
   * The Gateway waits in its update drive with no port (an interrupted copy, or BOOTSEL held): it
   * takes the copy as it is. Not ok when it has left the drive (`none`: it is running again, or was
   * unplugged) or while more than one update drive is mounted (`many`: no guessing which board is
   * the Gateway).
   */
  | { kind: 'drive'; ok: boolean; problem?: 'none' | 'many' }
  /**
   * The target release is saved on this computer, with an image for this board. `bundle`: no image
   * is sent, the Gateway's own firmware carries it (the cockpit side, #187). `checking`: the saved
   * image is being read and checked against the board.
   */
  | { kind: 'image'; ok: boolean; version: string; bundle?: true; checking?: true }
  /** The Gateway's USB side has the firmware uploader (it answers UPL_INFO): the cockpit side. */
  | { kind: 'uploader'; ok: boolean }
  /** No calibration session is open on the Gateway: it refuses an update meanwhile. */
  | { kind: 'calibration'; ok: boolean }
  /** The image to send was built for this board (its identity block): a staged image only. */
  | { kind: 'built-for'; ok: boolean; nodeId: number }
  /** The image fits a board's flash limit; the board checks its own before anything is erased. */
  | { kind: 'fits'; ok: boolean; maxKb: number }

/**
 * One step of the run, by key. The Gateway's USB side: restart, copy, reconnect, confirm. A board
 * through the Gateway's uploader (#187): stage (only when an image is sent), enter its bootloader,
 * write, verify, restart, confirm.
 */
export type UpdateStepKey =
  | 'uf2'
  | 'copy'
  | 'rec'
  | 'stage'
  | 'boot'
  | 'write'
  | 'verify'
  | 'restart'
  | 'ver'

export interface UpdateStep {
  key: UpdateStepKey
  state: 'waiting' | 'on' | 'done' | 'bad'
  /** The copy's, staging's or writing's progress, 0–100, while it runs. */
  pct?: number
}

/**
 * A line the run shows above its steps (#187): the whole cockpit is paused; a write was
 * interrupted and is retried automatically (`n` of `of`); the retry went through; the client lost
 * contact and the Gateway carries on; contact is back; press the board's reset button (a Retry
 * after it didn't answer).
 */
export type UpdateNote =
  | { kind: 'paused' }
  | { kind: 'retrying'; n: number; of: number }
  | { kind: 'recovered' }
  | { kind: 'cut-off' }
  | { kind: 'back' }
  | { kind: 'press-reset' }

/** Why the board refused an image before writing it. */
export type UpdateRefusal = 'wrong-kind' | 'wrong-id' | 'too-big'

/** Why the run stopped. Retry picks up where the failure says it safely can. */
export type UpdateFailure =
  /** The saved image couldn't be read; `message` is the release cache's own words (#192). */
  | { kind: 'image'; message: string }
  /** No update drive appeared after the restart (or there was no Gateway to restart). */
  | { kind: 'no-drive' }
  /** The copy to the update drive failed, or the drive went away during it. */
  | { kind: 'copy-failed' }
  /** With no Gateway port, more than one update drive is mounted: another RP2040 board's too. */
  | { kind: 'many-drives' }
  /** Started from the update drive, but the Gateway runs as a port again: nothing to copy to. */
  | { kind: 'left-drive' }
  /** The Gateway didn't come back, or didn't report its version, after the copy. */
  | { kind: 'no-reconnect' }
  /** It came back on another version than the target. */
  | { kind: 'wrong-version'; reported: string }
  // ── through the Gateway's uploader (#187) ──
  /** The board didn't answer the request to enter its bootloader: nothing was written. */
  | { kind: 'no-response' }
  /** The board has no bootloader: only a programmer updates it. */
  | { kind: 'no-bootloader' }
  /** The board refused the image, before or after its erase (`after`). */
  | { kind: 'refused'; why: UpdateRefusal }
  /** Writing or verifying failed after the automatic retries. */
  | { kind: 'write-failed' }
  /** It restarted but didn't report its new version in time. */
  | { kind: 'no-confirmation' }
  /** The Gateway lost power during the update, and the board doesn't answer now. */
  | { kind: 'not-responding' }
  /** The Gateway lost power during the update, before anything was written. */
  | { kind: 'interrupted' }
  /** A calibration session is open on the Gateway: it refuses the update meanwhile. */
  | { kind: 'busy' }
  /** The Gateway's USB side has no uploader: it needs newer firmware first. */
  | { kind: 'no-uploader' }
  /** The Gateway didn't take the image, or didn't answer. */
  | { kind: 'no-answer' }
  /** A result this client doesn't know (a newer Gateway). */
  | { kind: 'unknown-result' }
/** What happened to the Gateway's axis calibration across the update (no prompt, ever). */
export type UpdateCalibration =
  /** It was cleared, and this computer's copy was written back. */
  | 'restored'
  /** It was cleared, and this computer has no saved copy. */
  | 'cleared-no-copy'
  /** It was cleared, and writing this computer's copy back failed. */
  | 'restore-failed'

/** `update:state`: the update dialog, as main runs it. */
export interface UpdateState {
  target: UpdateTargetRef
  /** The board's name as the Firmware sheet shows it: `Gateway · USB side`. */
  name: string
  /** The version it reports now; absent when it reports none. */
  from?: string
  /**
   * It reports no version because it doesn't respond (#187): the update is a retry, and the
   * dialog shows the state in place of a version.
   */
  fromState?: 'not-responding'
  /**
   * No image is sent: the Gateway's own firmware carries the cockpit side's (#187). Absent: the
   * image comes from a saved release.
   */
  bundle?: true
  /** The image's size in KB, when one is sent and known. */
  sizeKb?: number
  /**
   * It waits in its update drive (no port, no version): the update starts at the copy, and the
   * steps begin there.
   */
  inDrive?: true
  /** The version it is updated to. */
  to: string
  phase: UpdatePhase
  /** The confirm step's checks, in the order the dialog lists them. */
  checks: UpdateCheck[]
  /**
   * The Gateway's two sides would be on different majors after this update: the USB side's and
   * the cockpit side's. The start waits for *I understand* (`ack`).
   */
  halves?: { usb: number; cockpit: number }
  ack: boolean
  /** Every check passes, and *I understand* is ticked when it's asked for. */
  canStart: boolean
  /** The rough time the update takes, in seconds (worded by `aboutSeconds`). */
  estimateSec: number
  steps: UpdateStep[]
  /** The whole update's progress, 0–100. */
  pct: number
  /** The run's line above its steps, while it runs (#187). */
  note?: UpdateNote
  /**
   * The run lost the Gateway and waits for it (#187): Close is offered, and leaves the Gateway to
   * finish on its own; the Firmware sheet shows what it runs once it is back.
   */
  closable?: true
  failure?: UpdateFailure
  /**
   * What a failure through the uploader left behind (#187): nothing written (`refused`), or the
   * board waiting in its bootloader (`erased`).
   */
  after?: 'refused' | 'erased'
  /** The result: the version it reports, and what happened to its calibration. */
  done?: { reports: string; calibration?: UpdateCalibration }
  /** The DCS relay is running (the confirm check, and the done step's hint when it isn't). */
  relayRunning: boolean
}

/** This topic's main -> renderer pushes; shared/app assembles them into `PushChannels`. */
export interface UpdatePushChannels {
  /** The update dialog after every change; null when no update is open. */
  'update:state': UpdateState | null
}

/** Push channel names (main -> renderer). */
export const UPDATE_PUSH = {
  updateState: 'update:state'
} as const

/** Intent channel names (renderer -> main, invoke/response). */
export const UPDATE_CTRL = {
  /** The dialog as main holds it: a reloaded renderer's pull. */
  updateGet: 'update:get',
  /** Open the dialog's confirm step for a target (refused while another update runs). */
  updateOpen: 'update:open',
  /** Tick or untick *I understand*. */
  updateAck: 'update:ack',
  updateStart: 'update:start',
  /** Run again from where the failure said it safely can. */
  updateRetry: 'update:retry',
  /** Close the dialog (not while it runs). */
  updateClose: 'update:close'
} as const
