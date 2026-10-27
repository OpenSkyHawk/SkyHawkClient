// The Gateway's link health (#169), from its DIAG record (pure, no Node/Electron deps). What main
// concludes from the counters, so the renderer and the debug log only read it.
import { CAL_DIAG_RESET_REASONS } from '@shared/firmware'
import type { GatewayDiag, GatewayLinkHealth, GatewayResetReason } from '@shared/gateway'

const R = CAL_DIAG_RESET_REASONS

/** CalDiagResetReason by name; a value newer than this client is `unknown`, never an error. */
export function resetReason(raw: number): GatewayResetReason {
  switch (raw) {
    case R.POWER_ON:
      return 'power-on'
    case R.WATCHDOG:
      return 'watchdog'
    case R.RECOVERY:
      return 'recovery'
    default:
      return 'unknown'
  }
}

/**
 * Which happened first this boot: a UART error or a USB loss (times are `millis()`, 0 = never).
 * The order tells the possible causes apart (#355). A tie reads as the UART: it is upstream.
 */
export function firstFault(d: GatewayDiag): 'uart' | 'usb' | null {
  const uart = d.firstUartErrMs
  const usb = d.firstUsbLossMs
  if (!uart && !usb) return null
  if (!usb) return 'uart'
  if (!uart) return 'usb'
  return uart <= usb ? 'uart' : 'usb'
}

/** The record as the client holds it: what it says, read at `at` (client clock). */
export function linkHealth(diag: GatewayDiag, at: number): GatewayLinkHealth {
  return {
    at,
    supported: true,
    diag,
    resetReason: resetReason(diag.resetReason),
    firstFault: firstFault(diag),
    // It re-plugged or rebooted itself: the evidence #355 is after.
    selfRecovered: diag.resetReason !== R.POWER_ON || diag.usbReattaches > 0
  }
}

/** No DIAG within the request timeout: firmware older than #355, not a link fault. */
export const unsupported = (at: number): GatewayLinkHealth => ({ at, supported: false })
