import { describe, expect, it } from 'vitest'
import { CAL_DIAG_RESET_REASONS as R } from '@shared/firmware'
import { diagRecord as diag } from '../../test-fixtures/diag'
import {
  BOOT_MATCH_MS,
  diagLogRow,
  firstFault,
  gatewayRecovery,
  isNewRecovery,
  recoveredThisBoot,
  resetReasonName
} from './gateway-diag'

/** A reset reason newer than this client: one past the highest it knows. */
const NEWER_REASON = Math.max(...Object.values(R)) + 1

describe('resetReasonName', () => {
  it('names each CalDiagResetReason; a newer one keeps its code', () => {
    expect([R.POWER_ON, R.WATCHDOG, R.RECOVERY].map(resetReasonName)).toEqual([
      'power-on',
      'watchdog',
      'recovery'
    ])
    expect(resetReasonName(NEWER_REASON)).toMatch(/^unknown reset reason \(0x[0-9A-F]+\)$/)
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

describe('gateway-diag.recovered: it re-plugged or restarted itself this boot', () => {
  it('a watchdog reset, a recovery reboot or a software re-plug — the reset reason first', () => {
    expect(recoveredThisBoot(diag({ resetReason: R.WATCHDOG }))).toBe('watchdog')
    expect(recoveredThisBoot(diag({ resetReason: R.RECOVERY }))).toBe('recovery')
    expect(recoveredThisBoot(diag({ usbReattaches: 1 }))).toBe('re-plug')
    expect(recoveredThisBoot(diag({ resetReason: R.RECOVERY, usbReattaches: 3 }))).toBe('recovery')
  })

  it('all clear: not recovered', () => {
    expect(recoveredThisBoot(diag())).toBeNull()
    expect(gatewayRecovery(diag(), 0, 'S1')).toBeNull()
  })
})

describe('diag.old-counts-dont-flag', () => {
  it('reboot and watchdog counts from earlier boots never flag; the debug row keeps both', () => {
    const d = diag({ recoveryReboots: 2, watchdogResets: 3 })
    expect(recoveredThisBoot(d)).toBeNull()
    expect(diagLogRow(d)).toMatchObject({
      recoveryReboots: 2,
      watchdogResets: 3,
      resetReason: 'power-on',
      recoveredThisBoot: null
    })
  })
})

describe('gateway-diag.unknown-reason', () => {
  it('a reset reason newer than this client, no re-plugs: not recovered, labelled in the debug row', () => {
    const d = diag({ resetReason: NEWER_REASON })
    expect(recoveredThisBoot(d)).toBeNull()
    expect(diagLogRow(d).resetReason).toBe(resetReasonName(NEWER_REASON))
    expect(diagLogRow(d).resetReason).toMatch(/^unknown/)
  })
})

describe('gatewayRecovery: what the connect read hands on', () => {
  it('how, its boot on the client clock (read time minus uptime), the re-plugs and the serial', () => {
    expect(gatewayRecovery(diag({ uptimeMs: 60_000, usbReattaches: 2 }), 1_000_000, 'S1')).toEqual({
      how: 're-plug',
      bootAt: 940_000,
      reattaches: 2,
      serial: 'S1'
    })
  })
})

describe('isNewRecovery', () => {
  const mark = { bootAt: 1_000_000, reattaches: 1 }

  it('the first for this Gateway is new', () => {
    expect(isNewRecovery(undefined, mark)).toBe(true)
  })

  it('the same boot (within BOOT_MATCH_MS) with no more re-plugs is not', () => {
    expect(isNewRecovery(mark, { ...mark, bootAt: mark.bootAt + BOOT_MATCH_MS })).toBe(false)
    expect(isNewRecovery(mark, { ...mark, bootAt: mark.bootAt - BOOT_MATCH_MS })).toBe(false)
  })

  it('the same boot with more re-plugs is', () => {
    expect(isNewRecovery(mark, { ...mark, reattaches: 2 })).toBe(true)
  })

  it('another boot is, even with the same count', () => {
    expect(isNewRecovery(mark, { ...mark, bootAt: mark.bootAt + BOOT_MATCH_MS + 1 })).toBe(true)
  })
})
