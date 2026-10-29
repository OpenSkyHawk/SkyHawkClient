// #173: the Firmware button's tooltip and the Overview banner's words, for the counts the bench
// tests don't reach.
import { describe, expect, it } from 'vitest'
import type { FirmwareBanner, FirmwareRow, FirmwareSheet } from '@shared/nodes'
import { firmwareBannerText, firmwareButton, firmwareRowView } from './firmware-view'

const banner = (over: Partial<FirmwareBanner>): FirmwareBanner => ({
  version: '1.0.1',
  gateway: false,
  pdus: 0,
  boards: 0,
  manual: 0,
  ...over
})

describe('firmware words (#173)', () => {
  it('the banner lists what can update by kind, and counts the manual boards', () => {
    expect(firmwareBannerText(banner({ gateway: true, pdus: 1, boards: 2, manual: 2 }))).toEqual({
      head: 'Firmware 1.0.1 is out',
      detail: 'the Gateway, 1 PDU and 2 boards can update. 2 more boards need a manual update.'
    })
    expect(firmwareBannerText(banner({ pdus: 3 })).detail).toBe('3 PDUs can update.')
    expect(firmwareBannerText(banner({ manual: 2 })).detail).toBe('2 boards need a manual update.')
  })

  it('the button: one board needs attention', () => {
    const sheet: FirmwareSheet = { target: '1.0.1', rows: [], attention: 1, allCurrent: false }
    expect(firmwareButton(sheet)).toEqual({
      count: 1,
      dot: 'new',
      title: '1 board needs attention · latest release 1.0.1'
    })
  })

  it('custom firmware on a Gateway side names no NODE_ID', () => {
    const r = firmwareRowView(
      {
        key: 'usb',
        side: 'usb',
        name: 'Gateway · USB side',
        status: 'custom',
        version: '1.0.0',
        attention: false
      },
      '1.0.1'
    )
    expect(r).toMatchObject({ chip: 'CUSTOM FIRMWARE', sub: '1.0.0 · no image in 1.0.1' })
    expect(r.opens).toBeUndefined()
  })
})

describe('the Gateway cockpit side’s row in words (#187)', () => {
  const ck = (over: Partial<FirmwareRow>): FirmwareRow => ({
    key: 'cockpit',
    side: 'cockpit',
    name: 'Gateway · cockpit side',
    status: 'update',
    attention: true,
    ...over
  })

  it('against the bundle: carried by the USB side; behind the release: the USB side first', () => {
    const carried = firmwareRowView(
      ck({ version: '1.0.0', to: '1.0.1', bundled: true, action: 'update' }),
      '1.0.1'
    )
    expect(carried).toMatchObject({
      chip: 'UPDATE AVAILABLE',
      sub: '1.0.0 → 1.0.1 · carried by the USB side',
      button: 'Update',
      action: 'update'
    })
    expect(
      firmwareRowView(
        ck({ version: '1.0.0', to: '1.0.2', bundled: true, action: 'usb-first' }),
        '1.0.2'
      )
    ).toMatchObject({ sub: '1.0.0 → 1.0.2 · update the USB side first', button: 'Update' })
    expect(
      firmwareRowView(
        ck({ status: 'newer', version: '1.0.2', to: '1.0.1', bundled: true }),
        '1.0.1'
      ).sub
    ).toBe('1.0.2 · the USB side carries 1.0.1')
  })

  it('not responding: red, Retry; updating; every board paused', () => {
    expect(
      firmwareRowView(ck({ status: 'not-responding', to: '1.0.1', action: 'retry' }), '1.0.1')
    ).toMatchObject({
      chip: 'NOT RESPONDING',
      chipCls: 'vchip--err',
      dot: 'off',
      sub: 'the Gateway answers; its cockpit side doesn’t',
      button: 'Retry'
    })
    expect(
      firmwareRowView(ck({ status: 'updating', version: '1.0.0', to: '1.0.1' }), '1.0.1')
    ).toMatchObject({ chip: 'UPDATING', sym: '↻', sub: '1.0.0 → 1.0.1' })
    expect(
      firmwareRowView(
        { key: '1', nodeId: 1, name: 'Left_AFCS', status: 'paused', attention: false },
        '1.0.1'
      )
    ).toMatchObject({ chip: 'PAUSED', sub: 'Gateway cockpit side updating' })
  })
})
