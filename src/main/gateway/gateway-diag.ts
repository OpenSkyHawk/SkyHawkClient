// The Gateway's link health (#169), from its DIAG record: a model (pure, no I/O, time passed in).
// The one owner of "recovered itself": whether and how the Gateway re-plugged or restarted itself
// this boot, and whether a recovery is new since its last Events row. Evidence, never a fault: a
// normal PC shutdown may produce one. The record is read on the wire by hid/calibration (it owns
// that channel), which writes it to the debug log and hands the conclusion on (NodeHub →
// GatewayWatch); gateway-health decides how the Gateway shows it.
import { CAL_DIAG_RESET_REASONS } from '@shared/firmware'
import { unknownLabel } from '@shared/format'
import type { GatewayRecoveredHow } from '@shared/gateway'

const R = CAL_DIAG_RESET_REASONS

/**
 * The Gateway's DIAG record (AxisCal.h CalDiagField), the reply to GET_DIAG. Times are the
 * device's `millis()` since its boot, 0 = never; each field's width comes from the synced layout
 * (codec CAL_DIAG_WIDTH). Everything starts again at boot, except the reboot and watchdog counts,
 * which survive a warm reboot. Main-only: no surface shows the counters (debug log only).
 */
export interface GatewayDiag {
  /** Device `millis()` when the reply was built: the reference for every time below. */
  uptimeMs: number
  firstUartErrMs: number
  lastUartErrMs: number
  /** Healthy → unhealthy edges of its link to this computer. */
  firstUsbLossMs: number
  lastUsbLossMs: number
  uartOverrun: number
  uartFraming: number
  uartBreak: number
  uartParity: number
  uartRxOverflow: number
  linesDropped: number
  linesCorrupt: number
  linesOverlong: number
  framesDropped: number
  uartRestarts: number
  /** Software re-plugs this boot. */
  usbReattaches: number
  cdcStalls: number
  /** Recovery reboots, earlier boots included. */
  recoveryReboots: number
  /** Watchdog resets, earlier boots included. */
  watchdogResets: number
  /** CalDiagResetReason, raw: a value this client does not know is kept, never an error. */
  resetReason: number
}

/** CalDiagResetReason by name, for the debug log; a value newer than this client keeps its code. */
export function resetReasonName(raw: number): string {
  switch (raw) {
    case R.POWER_ON:
      return 'power-on'
    case R.WATCHDOG:
      return 'watchdog'
    case R.RECOVERY:
      return 'recovery'
    default:
      return unknownLabel('reset reason', raw, 'word')
  }
}

/**
 * Which happened first this boot: a UART error or a USB loss (times are `millis()`, 0 = never).
 * The order tells the possible causes apart (#355). A tie reads as the UART: it is upstream.
 * Debug log only. Raw times, so it can be wrong after ~49.7 days up (a `millis()` wrap): accepted.
 */
export function firstFault(d: GatewayDiag): 'uart' | 'usb' | null {
  const uart = d.firstUartErrMs
  const usb = d.firstUsbLossMs
  if (!uart && !usb) return null
  if (!usb) return 'uart'
  if (!uart) return 'usb'
  return uart <= usb ? 'uart' : 'usb'
}

/**
 * Whether it re-plugged or restarted itself this boot, and how: the reset reason first, then a
 * software re-plug (USB_REATTACHES counts from this boot). The reboot and watchdog counts survive
 * a warm reboot, so they describe earlier boots and never count here. An unknown reset reason
 * doesn't count either.
 */
export function recoveredThisBoot(d: GatewayDiag): GatewayRecoveredHow | null {
  if (d.resetReason === R.WATCHDOG) return 'watchdog'
  if (d.resetReason === R.RECOVERY) return 'recovery'
  return d.usbReattaches > 0 ? 're-plug' : null
}

/** A recovery as the Events memory keeps it: which boot, and how many re-plugs it had made. */
export interface RecoveryMark {
  /** Client clock at the Gateway's boot: the read time minus its uptime. */
  bootAt: number
  /** USB_REATTACHES at the read. */
  reattaches: number
}

/** What the connect read hands on when the Gateway recovered itself this boot. */
export interface GatewayRecovery extends RecoveryMark {
  how: GatewayRecoveredHow
  /** The Gateway's USB serial, the key of the Events memory; absent when it reports none. */
  serial?: string
}

/** The conclusion from one read at `at` (client clock); null when it didn't recover itself. */
export function gatewayRecovery(
  d: GatewayDiag,
  at: number,
  serial: string | undefined
): GatewayRecovery | null {
  const how = recoveredThisBoot(d)
  if (!how) return null
  return { how, bootAt: at - d.uptimeMs, reattaches: d.usbReattaches, serial }
}

/**
 * How far two reads' boot times may differ and still be the same boot. Each is the read time
 * minus the uptime the reply was built at, so they differ only by the reply's latency, which the
 * 2 s calibration request timeout bounds.
 */
export const BOOT_MATCH_MS = 2000

/**
 * A recovery worth an Events row: none written for this Gateway yet, a different boot, or the
 * same boot with more re-plugs. The counts alone can't tell boots apart: a power-on zeroes
 * USB_REATTACHES, so a re-plug in a new boot can show the same count as the last row.
 */
export function isNewRecovery(last: RecoveryMark | undefined, next: RecoveryMark): boolean {
  if (!last) return true
  if (Math.abs(next.bootAt - last.bootAt) > BOOT_MATCH_MS) return true
  return next.reattaches > last.reattaches
}

/** The `cal.diag` debug row: the whole record, and what this module concludes from it. */
export function diagLogRow(d: GatewayDiag): Record<string, unknown> {
  return {
    ...d,
    resetReason: resetReasonName(d.resetReason),
    firstFault: firstFault(d),
    recoveredThisBoot: recoveredThisBoot(d)
  }
}
