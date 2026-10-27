import { describe, expect, it } from 'vitest'
import type { GatewayDiag } from '@shared/gateway'
import { firstFault, linkHealth, resetReason, unsupportedLinkHealth } from './gateway-diag'

/** A healthy record: up an hour, nothing ever went wrong, a cold start. */
const diag = (over: Partial<GatewayDiag> = {}): GatewayDiag => ({
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
  resetReason: 0,
  ...over
})

describe('resetReason', () => {
  it('names each CalDiagResetReason, and a newer one unknown', () => {
    expect([0, 1, 2, 7].map(resetReason)).toEqual(['power-on', 'watchdog', 'recovery', 'unknown'])
  })
})

describe('firstFault: which came first this boot, UART error or USB loss', () => {
  it('neither: null', () => {
    expect(firstFault(diag())).toBeNull()
  })

  it('only one of them: that one', () => {
    expect(firstFault(diag({ firstUartErrMs: 500 }))).toBe('uart')
    expect(firstFault(diag({ firstUsbLossMs: 500 }))).toBe('usb')
  })

  it('both: the earlier one (a tie reads as the UART, upstream)', () => {
    expect(firstFault(diag({ firstUartErrMs: 900, firstUsbLossMs: 1200 }))).toBe('uart')
    expect(firstFault(diag({ firstUartErrMs: 1200, firstUsbLossMs: 900 }))).toBe('usb')
    expect(firstFault(diag({ firstUartErrMs: 900, firstUsbLossMs: 900 }))).toBe('uart')
  })
})

describe('linkHealth', () => {
  it('a cold start that never re-plugged: not self-recovered', () => {
    expect(linkHealth(diag(), 42)).toEqual({
      at: 42,
      supported: true,
      diag: diag(),
      resetReason: 'power-on',
      firstFault: null,
      selfRecovered: false
    })
  })

  it('a software re-plug, a watchdog or a recovery reboot is the evidence #355 needs', () => {
    expect(linkHealth(diag({ usbReattaches: 1 }), 0)).toMatchObject({ selfRecovered: true })
    expect(linkHealth(diag({ resetReason: 1 }), 0)).toMatchObject({
      resetReason: 'watchdog',
      selfRecovered: true
    })
    expect(linkHealth(diag({ resetReason: 2 }), 0)).toMatchObject({
      resetReason: 'recovery',
      selfRecovered: true
    })
  })

  it('no DIAG within the timeout is "not supported", not a fault', () => {
    expect(unsupportedLinkHealth(7)).toEqual({ at: 7, supported: false })
  })
})
