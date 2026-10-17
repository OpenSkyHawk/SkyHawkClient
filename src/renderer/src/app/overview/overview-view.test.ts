// The new-devices notice's wording (overview.ts). The tile, the banner and the counts are main's
// since R3.2b (main/nodes/cockpit-snapshot/overview-summary.test.ts).
import { describe, expect, it } from 'vitest'
import { newDevicesText } from './overview-view'

describe('newDevicesText', () => {
  it('lists the reported kinds', () => {
    expect(newDevicesText({ count: 1, panels: 0, pdus: 1, registry: 0 })).toEqual({
      head: '1 new device on the bus',
      detail: '1 PDU, not in NODE_IDS.md.'
    })
    expect(newDevicesText({ count: 3, panels: 1, pdus: 2, registry: 0 })).toEqual({
      head: '3 new devices on the bus',
      detail: '1 panel group, 2 PDUs, not in NODE_IDS.md.'
    })
  })

  it('a registry board waiting to be added is from NODE_IDS.md, not "not in" it (#93)', () => {
    expect(newDevicesText({ count: 1, panels: 1, pdus: 0, registry: 1 }).detail).toBe(
      '1 panel group from NODE_IDS.md, not added to your cockpit yet.'
    )
    expect(newDevicesText({ count: 3, panels: 2, pdus: 1, registry: 2 }).detail).toBe(
      '2 panel groups, 1 PDU, not added to your cockpit yet — 2 from NODE_IDS.md.'
    )
  })
})
