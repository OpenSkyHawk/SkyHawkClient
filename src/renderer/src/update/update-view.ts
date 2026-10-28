// The update dialog's words (#173), pure: main decides the phase, each check, each step, the
// failure and the result (`update:state`); this words them as the design draws them
// (CockpitMap.dc.html upVals :1018-1220, phases :910, failures :975-993).
import { aboutSeconds } from '@shared/format'
import type {
  UpdateCalibration,
  UpdateCheck,
  UpdateFailure,
  UpdateState,
  UpdateStepKey
} from '@shared/update'

export interface CheckView {
  ok: boolean
  text: string
  /** The button that fixes it: *Stop relay*, *Check for updates*. */
  fix?: 'stop-relay' | 'check-releases'
}

function checkView(c: UpdateCheck): CheckView {
  switch (c.kind) {
    case 'relay':
      return c.ok
        ? { ok: true, text: 'DCS relay stopped' }
        : {
            ok: false,
            text: 'The DCS relay is running — updates need the sim idle.',
            fix: 'stop-relay'
          }
    case 'link':
      return c.ok
        ? { ok: true, text: 'Gateway connected' }
        : { ok: false, text: 'The Gateway isn’t connected — connect it first.' }
    case 'image':
      return c.ok
        ? { ok: true, text: `Firmware ${c.version} · saved on this computer, checked` }
        : {
            ok: false,
            text: `Firmware ${c.version} isn’t on this computer.`,
            fix: 'check-releases'
          }
  }
}

const STEP: Record<UpdateStepKey, string> = {
  uf2: 'Restarting the Gateway to update it',
  copy: 'Copying the firmware',
  rec: 'Reconnecting',
  ver: 'Confirming the version it reports'
}

const SYM = { waiting: '·', on: '›', done: '✓', bad: '✕' } as const
const CLS = { waiting: '', on: 'up__p--on', done: 'up__p--done', bad: 'up__p--bad' } as const

/** The failure box's title and text, and the footer under it. */
function failView(f: UpdateFailure, to: string): { title: string; text: string; foot: string } {
  switch (f.kind) {
    case 'image':
      return {
        title: 'Firmware not available',
        text: f.message.charAt(0).toLowerCase() + f.message.slice(1),
        foot: 'Nothing was written.'
      }
    case 'no-drive':
      return {
        title: 'No Gateway drive appeared',
        text: 'hold BOOTSEL while plugging the Gateway in, then Retry. Nothing has been written yet.',
        foot: 'Nothing was written.'
      }
    case 'copy-failed':
      return {
        title: 'Copy failed',
        text: 'the Gateway’s drive went away during the copy. Retry copies the whole file again; if the Gateway doesn’t come back, hold BOOTSEL while plugging it in.',
        foot: 'The Gateway waits in its update drive until a copy goes through.'
      }
    case 'no-reconnect':
      return {
        title: 'Didn’t reconnect',
        text: 'the Gateway didn’t come back after the copy. Retry looks for it again.',
        foot: 'The copy finished. The client keeps looking for the Gateway.'
      }
    case 'wrong-version':
      return {
        title: 'Wrong version',
        text: `it reports ${f.reported}, not ${to}. Nothing is retried automatically.`,
        foot: 'It runs the version it reports.'
      }
  }
}

const CAL_NOTE: Record<UpdateCalibration, string> = {
  restored: 'Axis calibration restored from this computer’s copy.',
  'cleared-no-copy':
    'Axis calibration was cleared and this computer has no saved copy — calibrate it on the HID page (Device I/O › HID).',
  'restore-failed':
    'Axis calibration was cleared and restoring this computer’s copy failed — calibrate it on the HID page (Device I/O › HID).'
}

/** The dialog in words. */
export interface UpdateView {
  /** Header dot: blue while it waits or runs, green when done, red on a failure. */
  dot: 'new' | 'on' | 'off'
  title: string
  sub: string
  canClose: boolean
  /** Confirm: the board, its checks, the halves warning, the Gateway note. */
  board: { name: string; sub: string }
  checks: CheckView[]
  halves?: string
  note: string
  /** Run: each step, and the bar. */
  steps: { label: string; cls: string; sym: string }[]
  pct: number
  pctText: string
  fail?: { title: string; text: string }
  /** Done: the board's line, the calibration note, the relay hint. */
  doneSub?: string
  calNote?: string
  relayHint?: string
  foot: string
}

export function updateView(s: UpdateState): UpdateView {
  const from = s.from ?? 'version not reported'
  const sub = `${from} → ${s.to} · firmware ${s.to}`
  const failed = s.phase === 'fail' && s.failure ? failView(s.failure, s.to) : undefined
  const done = s.phase === 'done' ? s.done : undefined
  return {
    dot: s.phase === 'fail' ? 'off' : s.phase === 'done' ? 'on' : 'new',
    title:
      s.phase === 'confirm'
        ? `Update ${s.name}`
        : s.phase === 'run'
          ? `Updating ${s.name}`
          : s.phase === 'fail'
            ? `${s.name} didn’t update`
            : 'Update finished',
    sub: done ? `${s.name} reports ${done.reports}` : sub,
    canClose: s.phase !== 'run',
    board: { name: s.name, sub: `${from} → ${s.to}` },
    checks: s.checks.map(checkView),
    ...(s.halves && {
      halves: `its USB side would be on ${s.halves.usb}.x and its cockpit side on ${s.halves.cockpit}.x. Update both halves together.`
    }),
    note: 'it restarts to update and reconnects by itself. Keep it plugged in. If the update clears its axis calibration, this computer’s copy is restored automatically.',
    steps: s.steps.map((st) => ({
      label: st.key === 'copy' && st.pct !== undefined ? `${STEP.copy} · ${st.pct}%` : STEP[st.key],
      cls: CLS[st.state],
      sym: SYM[st.state]
    })),
    pct: s.pct,
    pctText: `${s.pct}% of this board`,
    ...(failed && { fail: { title: failed.title, text: failed.text } }),
    ...(done && {
      doneSub: `now ${done.reports}${done.calibration === 'restored' ? ' · axis calibration restored' : ''}`,
      ...(done.calibration && { calNote: CAL_NOTE[done.calibration] }),
      ...(!s.relayRunning && {
        relayHint: 'The relay stays stopped. Start it from the pill when you’re ready to fly.'
      })
    }),
    foot:
      s.phase === 'confirm'
        ? aboutSeconds(s.estimateSec)
        : s.phase === 'run'
          ? 'Keep the Gateway plugged in — it restarts and reconnects by itself.'
          : failed
            ? failed.foot
            : 'Each version is the one the board itself reports.'
  }
}
