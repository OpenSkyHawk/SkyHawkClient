// Update topic contract (#173): the one firmware update the client runs at a time, and the shared
// update dialog that shows it. Imported by main, preload and the renderer.
//
// Main decides every state: the checks, each step, the failure and the result. The renderer only
// words them, by key. #173 brings the Gateway's USB side; the cockpit side (#187) and the boards
// (#175) add their own targets, steps and failures here.
//
// Versions travel as `x.y.z` text, never as a release tag.

/** What an update is for. */
export type UpdateTargetRef = { kind: 'usb' }

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
  /** The target release is saved on this computer, with an image for this board. */
  | { kind: 'image'; ok: boolean; version: string }

/** One step of the run, by key. The Gateway's USB side: restart, copy, reconnect, confirm. */
export type UpdateStepKey = 'uf2' | 'copy' | 'rec' | 'ver'

export interface UpdateStep {
  key: UpdateStepKey
  state: 'waiting' | 'on' | 'done' | 'bad'
  /** The copy's progress, 0–100, while it runs. */
  pct?: number
}

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
  failure?: UpdateFailure
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
