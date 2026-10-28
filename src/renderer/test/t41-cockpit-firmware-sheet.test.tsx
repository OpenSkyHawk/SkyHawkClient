// T41 — the Firmware button, sheet and Overview banner (#173): every board against the newest
// release saved on this computer, as main decides it (`cockpit:snapshot` firmware), with the
// release check's card (#192's words) and the Settings link to the Cockpit.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import { RELEASES_STATE_DEFAULT, type ReleasesState } from '@shared/releases'
import type { NodeStatus } from '@shared/nodes'
import { Cockpit } from '../src/app/cockpit/Cockpit'
import { Overview } from '../src/app/overview/Overview'
import { Settings } from '../src/app/settings/Settings'
import { useNav } from '../src/app/kit'
import { renderScenario, settle } from './render'
import { skyhawk } from './skyhawk-mock'
import {
  connected,
  gateway,
  link,
  model,
  nodeStatus,
  notSeen,
  offline,
  panel,
  pdu,
  savedRelease
} from './scenarios'

const RELEASED = new Date(2026, 10, 29, 18, 6).getTime()

/** Main's release state after a check 2 minutes ago that found and saved 1.0.1. */
const CHECKED: ReleasesState = {
  ...RELEASES_STATE_DEFAULT,
  check: { kind: 'ok' },
  last: { checkedAt: Date.now() - 2 * 60_000, latest: { version: '1.0.1', date: RELEASED } },
  cached: [{ version: '1.0.1', bytes: 1_470_000 }],
  cachedBytes: 1_470_000,
  canClear: true
}

/** A status row reporting `v` with a bootloader, unless `bootloader: 0`. */
const fw = (nodeId: number, kind: number, v: string, over: Partial<NodeStatus> = {}) => {
  const [fwMajor, fwMinor, fwPatch] = v.split('.').map(Number)
  return nodeStatus(nodeId, { nodeKind: kind, fwMajor, fwMinor, fwPatch, bootloader: 1, ...over })
}
const usb = (v: string) => {
  const [major, minor, patch] = v.split('.').map(Number)
  return { major: major!, minor: minor!, patch: patch! }
}

/** The bench in the design: the Gateway behind, two PDUs behind, one at the release, custom ones. */
const BENCH = {
  device: connected(gateway({ fwMajor: 1, fwMinor: 0, fwPatch: 1, bootloader: 1 })),
  model: model([
    pdu(3, 'PDU_Left', { status: fw(3, 2, '1.0.0') }),
    pdu(4, 'PDU_Right', { status: fw(4, 2, '1.0.0') }),
    pdu(5, 'PDU_Center', { status: fw(5, 2, '1.0.1') }),
    pdu(6, 'PDU_Gauges', { status: fw(6, 2, '1.0.1') }),
    panel(10, 'Left_Throttle', { status: fw(10, 1, '1.0.0', { bootloader: 0 }) }),
    panel(11, 'Left_Fuel', { status: fw(11, 1, '1.0.0') }),
    panel(12, 'Right_Doppler', { status: fw(12, 1, '0.3.0') }),
    panel(13, 'Right_TACAN', notSeen()),
    panel(14, 'Right_Compass', { status: fw(14, 1, '0.0.0') }),
    panel(15, 'Center_Gauges', { ...offline(1), status: fw(15, 1, '1.0.0') })
  ]),
  releases: CHECKED,
  firmware: { usb: usb('1.0.0'), release: savedRelease('1.0.1') }
}

const button = () => screen.getByRole('button', { name: /^Firmware/ })
const rows = () =>
  within(screen.getByRole('list', { name: 'Boards' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent)

async function openSheet(scenario: Parameters<typeof renderScenario>[1]) {
  const r = await renderScenario(<Cockpit />, scenario)
  await r.user.click(button())
  return { ...r, sheet: screen.getByRole('dialog', { name: 'Firmware' }) }
}

describe('T41 the Firmware button and sheet (#173)', () => {
  it('the button counts the boards needing attention, with its tooltip', async () => {
    await renderScenario(<Cockpit />, BENCH)
    expect(button()).toHaveTextContent('Firmware· 5')
    expect(button()).toHaveAttribute('title', '5 boards need attention · latest release 1.0.1')
  })

  it('the release card is #192’s; Check for updates asks main', async () => {
    const { user, sheet } = await openSheet(BENCH)
    expect(within(sheet).getByText('Latest firmware 1.0.1')).toBeInTheDocument()
    expect(within(sheet).getByText('released 29 Nov · checked 2 min ago')).toBeInTheDocument()
    await user.click(within(sheet).getByRole('button', { name: 'Check for updates' }))
    expect(skyhawk().checkReleases).toHaveBeenCalledTimes(1)
  })

  it('Needs attention: the Gateway first, then the boards by NODE_ID, each with its chip', async () => {
    const { sheet } = await openSheet(BENCH)
    expect(within(sheet).getByRole('button', { name: 'Needs attention · 5' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(rows()).toEqual([
      '↑Gateway · USB sideUPDATE AVAILABLE1.0.0 → 1.0.1Update',
      '↑PDU_Left · #3UPDATE AVAILABLE1.0.0 → 1.0.1',
      '↑PDU_Right · #4UPDATE AVAILABLE1.0.0 → 1.0.1',
      '!Left_Throttle · #10MANUAL UPDATE ONLY1.0.0 · no bootloader — update it with a programmer',
      '!Right_Doppler · #12MAJOR MISMATCH0.3.0 · the Gateway is on 1.x'
    ])
    expect(
      within(sheet).getByText(
        'Versions as each board reports them. The latest release is saved on this computer, so updates work offline. Panel groups run their own builds; boards without a bootloader need a programmer.'
      )
    ).toBeInTheDocument()
    // Only the Gateway's USB side updates from here so far (PR 2); the rest come with #187 / #175.
    expect(within(sheet).getAllByRole('button', { name: 'Update' })).toHaveLength(1)
    expect(within(sheet).queryByRole('button', { name: /^(Retry|From file…)/ })).toBeNull()
  })

  it('All: every chip the design draws for this PR', async () => {
    const { user, sheet } = await openSheet(BENCH)
    await user.click(within(sheet).getByRole('button', { name: 'All · 12' }))
    expect(rows()).toEqual([
      '↑Gateway · USB sideUPDATE AVAILABLE1.0.0 → 1.0.1Update',
      'Gateway · cockpit sideUP TO DATE1.0.1',
      '↑PDU_Left · #3UPDATE AVAILABLE1.0.0 → 1.0.1',
      '↑PDU_Right · #4UPDATE AVAILABLE1.0.0 → 1.0.1',
      '!Left_Throttle · #10MANUAL UPDATE ONLY1.0.0 · no bootloader — update it with a programmer',
      '!Right_Doppler · #12MAJOR MISMATCH0.3.0 · the Gateway is on 1.x',
      'PDU_Center · #5UP TO DATE1.0.1',
      'PDU_Gauges · #6CUSTOM FIRMWARE1.0.1 · no image for #6 in 1.0.1',
      'Left_Fuel · #11CUSTOM FIRMWARE1.0.0 · panel groups install their own build',
      '✕Right_TACAN · #13OFFLINEno version reported',
      'Right_Compass · #14NOT REPORTEDversion not reported',
      '✕Center_Gauges · #15OFFLINElast reported 1.0.0'
    ])
  })

  it('a board row opens the board; the Gateway rows have nothing to open yet (#177)', async () => {
    const { user, sheet } = await openSheet(BENCH)
    expect(within(sheet).queryByRole('button', { name: /^Open Gateway/ })).toBeNull()
    await user.click(within(sheet).getByRole('button', { name: 'Open PDU_Left · #3' }))
    expect(screen.queryByRole('dialog', { name: 'Firmware' })).toBeNull()
    expect(screen.getByRole('dialog', { name: /PDU_Left/ })).toBeInTheDocument()
  })

  it('newer than the release: nothing needs attention, and it doesn’t say every board runs it', async () => {
    const { sheet, user } = await openSheet({
      device: connected(gateway({ fwMajor: 1, fwMinor: 0, fwPatch: 1, bootloader: 1 })),
      model: model([pdu(3, 'PDU_Left', { status: fw(3, 2, '1.0.2') })]),
      releases: CHECKED,
      firmware: { usb: usb('1.0.1'), release: savedRelease('1.0.1') }
    })
    expect(within(sheet).getByText('Nothing needs attention.')).toBeInTheDocument()
    await user.click(within(sheet).getByRole('button', { name: 'All · 3' }))
    expect(rows()[2]).toBe('PDU_Left · #3NEWER THAN RELEASE1.0.2 · the release is 1.0.1')
    expect(button()).toHaveTextContent(/^Firmware$/)
    expect(button()).toHaveAttribute('title', 'Nothing needs attention · latest release 1.0.1')
  })

  it('every board on the release', async () => {
    const { sheet } = await openSheet({
      device: connected(gateway({ fwMajor: 1, fwMinor: 0, fwPatch: 1, bootloader: 1 })),
      model: model([pdu(3, 'PDU_Left', { status: fw(3, 2, '1.0.1') })]),
      releases: CHECKED,
      firmware: { usb: usb('1.0.1'), release: savedRelease('1.0.1') }
    })
    expect(within(sheet).getByText('Every board runs the latest release.')).toBeInTheDocument()
    expect(button()).toHaveAttribute('title', 'Every board runs 1.0.1')
  })

  it('the Gateway waiting in its update drive (link down): its row, in Needs attention, with Update', async () => {
    const { sheet } = await openSheet({
      ...BENCH,
      device: link('reconnecting'),
      firmware: { release: savedRelease('1.0.1'), usbDrives: 1 }
    })
    expect(rows()[0]).toBe('!Gateway · USB sideIN UPDATE DRIVEwaiting in its update driveUpdate')
    expect(within(sheet).getByRole('button', { name: 'Needs attention · 1' })).toBeInTheDocument()
    expect(button()).toHaveTextContent('Firmware· 1')
  })

  it('link down: every row not reported; nothing needs attention, and it doesn’t say every board runs it', async () => {
    const { sheet } = await openSheet({ ...BENCH, device: link('disconnected') })
    expect(within(sheet).getByText('Nothing needs attention.')).toBeInTheDocument()
    expect(button()).toHaveAttribute('title', 'Nothing needs attention · latest release 1.0.1')
  })

  it('nothing saved: no compare, and the button says so', async () => {
    const { sheet, user } = await openSheet({
      ...BENCH,
      releases: RELEASES_STATE_DEFAULT,
      firmware: { usb: usb('1.0.0') }
    })
    expect(button()).toHaveAttribute('title', 'No firmware release saved on this computer')
    expect(within(sheet).getByText('Not checked yet')).toBeInTheDocument()
    await user.click(within(sheet).getByRole('button', { name: /^All/ }))
    expect(rows().slice(0, 3)).toEqual([
      'Gateway · USB side1.0.0',
      'Gateway · cockpit side1.0.1',
      '!Left_Throttle · #10MANUAL UPDATE ONLY1.0.0 · no bootloader — update it with a programmer'
    ])
    expect(
      within(sheet).getByText(
        'Versions as each board reports them. Panel groups run their own builds; boards without a bootloader need a programmer.'
      )
    ).toBeInTheDocument()
  })
})

describe('T41 the Overview firmware banner (#173)', () => {
  const banner = () =>
    screen.queryByText(/^Firmware \d+\.\d+\.\d+ is out$/)?.closest('.info-banner')

  it('names what can update, then the manual boards; Review in Cockpit → opens the Cockpit', async () => {
    const { user } = await renderScenario(<Overview />, BENCH)
    expect(banner()).toHaveTextContent(
      '↑Firmware 1.0.1 is out — the Gateway and 2 PDUs can update. 1 more board needs a manual update.Review in Cockpit →'
    )
    await user.click(screen.getByRole('button', { name: 'Review in Cockpit →' }))
    expect(useNav.getState().tab).toBe('cockpit')
  })

  it('only manual boards behind', async () => {
    await renderScenario(<Overview />, {
      device: connected(gateway({ fwMajor: 1, fwMinor: 0, fwPatch: 1, bootloader: 1 })),
      model: model([panel(10, 'Left_Throttle', { status: fw(10, 1, '1.0.0', { bootloader: 0 }) })]),
      firmware: { usb: usb('1.0.1'), release: savedRelease('1.0.1') }
    })
    expect(banner()).toHaveTextContent('Firmware 1.0.1 is out — 1 board needs a manual update.')
  })

  it('none while nothing is behind or the link is down', async () => {
    const { sky } = await renderScenario(<Overview />, {
      ...BENCH,
      model: model([pdu(3, 'PDU_Left', { status: fw(3, 2, '1.0.1') })]),
      firmware: { usb: usb('1.0.1'), release: savedRelease('1.0.1') }
    })
    expect(banner()).toBeFalsy()
    sky.emitScenario({ firmware: { usb: usb('1.0.0'), release: savedRelease('1.0.1') } })
    await settle()
    expect(banner()).toBeTruthy()
    sky.emitScenario({ device: link('disconnected') })
    await settle()
    expect(banner()).toBeFalsy()
  })
})

describe('T41 Settings › Cockpit › Firmware updates: Open Cockpit → (#173)', () => {
  it('opens the Cockpit tab', async () => {
    const { user } = await renderScenario(<Settings />, { device: connected(), releases: CHECKED })
    await user.click(screen.getByRole('button', { name: /^Cockpit/ }))
    await settle()
    await user.click(screen.getByRole('button', { name: 'Open Cockpit →' }))
    expect(useNav.getState().tab).toBe('cockpit')
  })
})
