// #173: the Firmware button's tooltip and the Overview banner's words, for the counts the bench
// tests don't reach.
import { describe, expect, it } from 'vitest'
import type { FirmwareBanner, FirmwareSheet } from '@shared/nodes'
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
