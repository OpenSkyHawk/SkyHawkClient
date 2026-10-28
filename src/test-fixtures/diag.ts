// Shared DIAG fixtures for tests (#169; test-only: no production code may import this folder).
//
// Built at the synced offsets (CAL_DIAG_FIELD) and the codec's derived widths, so no test restates
// the record's layout.
import { CAL_DIAG_BYTES, CAL_DIAG_FIELD, CAL_DIAG_RESET_REASONS } from '@shared/firmware'
import type { GatewayDiag } from '../main/gateway'
import { CAL_DIAG_WIDTH } from '../main/hid/calibration/codec'

export type DiagFieldName = keyof typeof CAL_DIAG_WIDTH

/** A DIAG payload with these fields set (the rest 0), little-endian at their offsets and widths. */
export function diagPayload(set: Partial<Record<DiagFieldName, number>> = {}): Uint8Array {
  const p = new Uint8Array(CAL_DIAG_BYTES)
  for (const [k, n] of Object.entries(set) as [DiagFieldName, number][]) {
    let v = n
    for (let i = 0; i < CAL_DIAG_WIDTH[k]; i++) {
      p[CAL_DIAG_FIELD[k] + i] = v % 0x100
      v = Math.floor(v / 0x100)
    }
  }
  return p
}

/** A decoded record: up an hour, nothing ever went wrong, a cold start. */
export const diagRecord = (over: Partial<GatewayDiag> = {}): GatewayDiag => ({
  uptimeMs: 3_600_000,
  firstUartErrMs: 0,
  lastUartErrMs: 0,
  firstUsbLossMs: 0,
  lastUsbLossMs: 0,
  uartOverrun: 0,
  uartFraming: 0,
  uartBreak: 0,
  uartParity: 0,
  uartRxOverflow: 0,
  linesDropped: 0,
  linesCorrupt: 0,
  linesOverlong: 0,
  framesDropped: 0,
  uartRestarts: 0,
  usbReattaches: 0,
  cdcStalls: 0,
  recoveryReboots: 0,
  watchdogResets: 0,
  resetReason: CAL_DIAG_RESET_REASONS.POWER_ON,
  ...over
})
