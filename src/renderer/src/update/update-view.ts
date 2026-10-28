// The update dialog's words (#173, #187), pure: main decides the phase, each check, each step, the
// failure and the result (`update:state`); this words them as the design draws them
// (CockpitMap.dc.html upVals :1018-1220, phases :910, failures :975-993; the cockpit side's node-0
// path, its notes and footers). Copy never names the transport.
import { BOOT, UPL_PROTO } from '@shared/firmware'
import { aboutSeconds } from '@shared/format'
import type {
  UpdateCalibration,
  UpdateCheck,
  UpdateFailure,
  UpdateNote,
  UpdateRefusal,
  UpdateState,
  UpdateStepKey
} from '@shared/update'

export interface CheckView {
  ok: boolean
  text: string
  /**
   * The button that fixes it: *Stop relay*, *Check for updates*, *Update the USB side first* (the
   * Gateway's USB side has no uploader, #187).
   */
  fix?: 'stop-relay' | 'check-releases' | 'usb-first'
}

/** A check as drawn, or undefined for one the dialog lists only when it fails (the uploader). */
function checkView(c: UpdateCheck): CheckView | undefined {
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
    case 'drive':
      return c.ok
        ? { ok: true, text: 'Gateway waiting in its update drive' }
        : c.problem === 'many'
          ? {
              ok: false,
              text: 'More than one update drive is mounted — unplug the other RP2040 board.'
            }
          : {
              ok: false,
              text: 'The Gateway left its update drive — close and update it from its row.'
            }
    case 'image':
      if (c.bundle) return { ok: true, text: 'Carried by the Gateway’s firmware' }
      if (c.ok && c.checking) {
        return { ok: true, text: `Firmware ${c.version} · saved on this computer, checking…` }
      }
      return c.ok
        ? { ok: true, text: `Firmware ${c.version} · saved on this computer, checked` }
        : {
            ok: false,
            text: `Firmware ${c.version} isn’t on this computer.`,
            fix: 'check-releases'
          }
    case 'uploader':
      return c.ok
        ? undefined
        : {
            ok: false,
            text: 'The Gateway’s USB side needs newer firmware to update its cockpit side — update the USB side first.',
            fix: 'usb-first'
          }
    case 'calibration':
      return c.ok
        ? { ok: true, text: 'No calibration session open' }
        : { ok: false, text: 'A calibration session is open — finish or cancel it first.' }
    case 'built-for':
      return c.ok
        ? { ok: true, text: `Built for #${c.nodeId} · Gateway · cockpit side — matches this board` }
        : {
            ok: false,
            text: `The saved image isn’t built for #${c.nodeId} · Gateway · cockpit side.`
          }
    case 'fits':
      return c.ok
        ? {
            ok: true,
            text: `Fits the ${c.maxKb} KB limit; the board checks its own flash before anything is erased`
          }
        : { ok: false, text: `The image is bigger than the ${c.maxKb} KB a board takes.` }
  }
}

const STEP: Record<UpdateStepKey, string> = {
  uf2: 'Restarting the Gateway to update it',
  copy: 'Copying the firmware',
  rec: 'Reconnecting',
  stage: 'Staging the image on the Gateway',
  boot: 'Entering its bootloader',
  write: 'Writing',
  verify: 'Verifying',
  restart: 'Restarting',
  ver: 'Confirming the version it reports'
}

/** A step's label: with its progress while it fills (the copy, staging, writing). */
function stepLabel(key: UpdateStepKey, pct: number | undefined): string {
  return pct === undefined ? STEP[key] : `${STEP[key]} · ${pct}%`
}

const RETRIES = UPL_PROTO.retries
const SETTLE_S = BOOT.idleTimeoutMs / 1000

/** The run's line above its steps (#187): its box's tone, title and text. */
function noteView(n: UpdateNote): { cls: string; title: string; text: string } {
  switch (n.kind) {
    case 'paused':
      return {
        cls: 'sh__fault--new',
        title: 'Cockpit paused',
        text: 'the whole cockpit is paused while the cockpit side updates.'
      }
    case 'retrying':
      return {
        cls: 'sh__fault--warn',
        title: 'Write interrupted',
        text: `retrying automatically (${n.n} of ${n.of}).`
      }
    case 'recovered':
      return { cls: 'sh__fault--new', title: 'Recovered', text: 'the retry went through.' }
    case 'cut-off':
      return {
        cls: 'sh__fault--warn',
        title: 'Client cut off',
        text: 'the client lost contact with the Gateway. The Gateway finishes this board on its own; the result shows when it’s back.'
      }
    case 'back':
      return {
        cls: 'sh__fault--new',
        title: 'Back online',
        text: 'the Gateway carried on by itself while the client was cut off.'
      }
    case 'press-reset':
      return {
        cls: 'sh__fault--warn',
        title: 'Press the reset button on the Gateway board',
        text: 'if nothing happens within a few seconds, press it again. Check the cockpit is powered.'
      }
  }
}

const REFUSED: Record<UpdateRefusal, { title: string; text: string }> = {
  'wrong-kind': {
    title: 'Refused — wrong board',
    text: 'the board’s bootloader reports a different node ID or kind than the image.'
  },
  'wrong-id': {
    title: 'Refused — wrong board',
    text: 'the board’s bootloader reports a different node ID or kind than the image.'
  },
  'too-big': { title: 'Refused — too big', text: 'the image doesn’t fit this board’s flash.' }
}

/** What a failure through the uploader left: nothing written, or the board in its bootloader. */
const AFTER: Record<'refused' | 'erased', string> = {
  refused: `Nothing was written. The board goes back to its old firmware within ${SETTLE_S} s.`,
  erased: 'Nothing else changed. The cockpit side waits in its bootloader; Retry finishes it.'
}

const SYM = { waiting: '·', on: '›', done: '✓', bad: '✕' } as const
const CLS = { waiting: '', on: 'up__p--on', done: 'up__p--done', bad: 'up__p--bad' } as const

/**
 * The failure box's title and text, and the footer under it: the failure's own, else what the run
 * left behind (`after`).
 */
function failView(
  f: UpdateFailure,
  to: string,
  after: UpdateState['after']
): { title: string; text: string; foot: string } {
  const left = after ? AFTER[after] : ''
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
    case 'many-drives':
      return {
        title: 'More than one update drive',
        text: 'another RP2040 board is waiting in its update drive too. Unplug it, then Retry.',
        foot: 'Nothing was written.'
      }
    case 'left-drive':
      return {
        title: 'Not in its update drive',
        text: 'the Gateway is running again, so there is nothing to copy to. Close, and update it from its row.',
        foot: 'Nothing was written.'
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
    case 'no-response':
      return {
        title: 'No response',
        text: 'press the reset button on the Gateway board. If nothing happens within a few seconds, press it again. Check the cockpit is powered.',
        foot: 'Nothing was written.'
      }
    case 'no-bootloader':
      return {
        title: 'No bootloader',
        text: 'the board didn’t enter a bootloader. Flash it once with a programmer; after that it updates from here.',
        foot: left
      }
    case 'refused':
      return { ...REFUSED[f.why], foot: left }
    case 'write-failed':
      return {
        title: 'Stuck in its bootloader',
        text: `writing failed after ${RETRIES} automatic retries. Its bootloader is intact and waits for an image — nothing is lost. Retry finishes it.`,
        foot: left
      }
    case 'no-confirmation':
      return {
        title: 'No confirmation',
        text: 'it didn’t report its new version after the update.',
        foot: 'Check its version on the Firmware sheet.'
      }
    case 'not-responding':
      return {
        title: 'Not responding',
        text: 'the Gateway lost power while its cockpit side was updating, and the cockpit side doesn’t answer now. Retry the update.',
        foot: 'The cockpit side waits in its bootloader; Retry finishes it.'
      }
    case 'interrupted':
      return {
        title: 'Interrupted',
        text: 'the Gateway lost power before anything was written.',
        foot: left
      }
    case 'busy':
      return {
        title: 'Calibration session open',
        text: 'the Gateway refuses an update while a calibration session is open. Finish or cancel it, then Retry.',
        foot: 'Nothing was written.'
      }
    case 'no-uploader':
      return {
        title: 'Gateway needs newer firmware',
        text: 'the Gateway’s USB side needs newer firmware to update its cockpit side — update the USB side first.',
        foot: 'Nothing was written.'
      }
    case 'no-answer':
      return {
        title: 'No answer',
        text: 'the Gateway didn’t answer. Check it’s connected, then Retry.',
        foot: 'Nothing was written.'
      }
    case 'unknown-result':
      return {
        title: 'Unknown result',
        text: 'the Gateway reported a result this client doesn’t know. Check its version on the Firmware sheet.',
        foot: ''
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
  board: { name: string; sub: string; chip: string; chipCls: string }
  checks: CheckView[]
  halves?: string
  note: { title: string; text: string }
  /** The confirm button: *Retry the update* when the board doesn't respond (#187). */
  startLabel: string
  /** Run: the line above the steps (#187), each step, and the bar. */
  runNote?: { cls: string; title: string; text: string }
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
  const cockpit = s.target.kind === 'cockpit'
  const from = s.inDrive
    ? 'in its update drive'
    : s.fromState === 'not-responding'
      ? 'not responding'
      : (s.from ?? 'version not reported')
  const source = s.bundle ? 'carried by the USB side' : `firmware ${s.to}`
  const sub = `${from} → ${s.to} · ${source}`
  const failed = s.phase === 'fail' && s.failure ? failView(s.failure, s.to, s.after) : undefined
  const done = s.phase === 'done' ? s.done : undefined
  const about = aboutSeconds(s.estimateSec)
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
    canClose: s.phase !== 'run' || !!s.closable,
    board: {
      name: s.name,
      sub: `${from} → ${s.to}`,
      ...(s.inDrive
        ? { chip: 'IN UPDATE DRIVE', chipCls: 'vchip--warn' }
        : s.fromState === 'not-responding'
          ? { chip: 'NOT RESPONDING', chipCls: 'vchip--err' }
          : { chip: 'UPDATE AVAILABLE', chipCls: 'vchip--upd' })
    },
    checks: s.checks.map(checkView).filter((c): c is CheckView => !!c),
    ...(s.halves && {
      halves: `its USB side would be on ${s.halves.usb}.x and its cockpit side on ${s.halves.cockpit}.x. Update both halves together.`
    }),
    note: cockpit
      ? {
          title: 'The whole cockpit pauses',
          text: `every board’s input goes through the Gateway’s cockpit side. ${about.charAt(0).toUpperCase()}${about.slice(1)}; the boards’ warning LEDs light briefly.`
        }
      : {
          title: 'Gateway',
          text: s.inDrive
            ? 'it restarts by itself once the copy lands, and reconnects. Keep it plugged in. If the update clears its axis calibration, this computer’s copy is restored automatically.'
            : 'it restarts to update and reconnects by itself. Keep it plugged in. If the update clears its axis calibration, this computer’s copy is restored automatically.'
        },
    startLabel: s.fromState === 'not-responding' ? 'Retry the update' : `Update to ${s.to}`,
    ...(s.phase === 'run' && s.note && { runNote: noteView(s.note) }),
    steps: s.steps.map((st) => ({
      label: stepLabel(st.key, st.pct),
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
        ? s.sizeKb !== undefined
          ? `${s.sizeKb} KB · ${about}`
          : about
        : s.phase === 'run'
          ? s.note?.kind === 'cut-off'
            ? 'The client can’t reach the Gateway — it finishes this board by itself. You can close this; the Firmware sheet shows what it runs once it’s back.'
            : cockpit
              ? 'Don’t unplug the Gateway. Closing the client is fine — the Gateway finishes on its own.'
              : 'Keep the Gateway plugged in — it restarts and reconnects by itself.'
          : failed
            ? failed.foot
            : 'Each version is the one the board itself reports.'
  }
}
