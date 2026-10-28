// One update target's own part of the update dialog (#187): its name, steps, checks and run. The
// host (update-host.ts) owns what every update shares — the relay and link checks, *I understand*,
// one update at a time, the phase, Retry from where the failure says, Close — and asks the flow
// for the rest. The Gateway's USB side (#173) and its cockpit side (#187) are flows; the boards
// (#175) add theirs.
import type {
  UpdateCalibration,
  UpdateCheck,
  UpdateFailure,
  UpdateNote,
  UpdateState,
  UpdateStepKey,
  UpdateTargetRef
} from '@shared/update'

/** Told as the run goes: a step starts, its progress, the line above the steps. */
export interface StepReport {
  step(index: number): void
  pct(n: number): void
  /** The run's note (#187); undefined clears it. */
  note?(note: UpdateNote | undefined): void
}

export type RunResult =
  | { ok: true; reports: string; calibration?: UpdateCalibration }
  | {
      ok: false
      failure: UpdateFailure
      at: number
      retryFrom: number
      /** What it left behind (#187): nothing written, or the board in its bootloader. */
      after?: 'refused' | 'erased'
    }

/** What a flow adds to the dialog beyond the host's own fields. */
export type FlowView = Pick<
  UpdateState,
  'from' | 'fromState' | 'inDrive' | 'bundle' | 'sizeKb' | 'halves'
>

export interface UpdateFlow {
  readonly target: UpdateTargetRef
  /** The board's name as the Firmware sheet shows it. */
  readonly name: string
  /** The version it is updated to. */
  readonly to: string
  /** The rough time the update takes, in seconds. */
  readonly estimateSec: number
  /** The run's steps, in order; may change once the run knows more (an image to stage). */
  steps(): readonly UpdateStepKey[]
  /** The first step the dialog lists: the steps before it are skipped (USB side, from its drive). */
  first(): number
  /** The target's own confirm checks, after the host's relay check. */
  checks(): UpdateCheck[]
  view(): FlowView
  /** Read what the confirm step shows before the run (a saved image's identity); then pushed. */
  prepare?(): Promise<void>
  /** Run from step `from`; resolves with the result or the failure and where Retry may restart. */
  run(from: number, report: StepReport): Promise<RunResult>
  /** The dialog closed in `phase` (never while it runs): give back what the run held. */
  close(phase: Exclude<UpdateState['phase'], 'run'>): void
}
