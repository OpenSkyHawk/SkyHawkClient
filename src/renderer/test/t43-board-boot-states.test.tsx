// T43 — a board its bootloader holds (#175): *Needs firmware* / *Won't start* in Attention (the
// cog opens the Firmware sheet) and in the board's Status › Firmware section, the chip beside the
// version, the note only with a release image, and the *No bootloader* box with its docs link.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import { BOOT_STATE } from '@shared/firmware'
import type { NodeStatus } from '@shared/nodes'
import { Cockpit } from '../src/app/cockpit/Cockpit'
import { renderScenario } from './render'
import {
  connected,
  gateway,
  model,
  nodeStatus,
  offline,
  panel,
  pdu,
  savedRelease
} from './scenarios'

/** A status row reporting `v` with a bootloader, unless `bootloader: 0`. */
const fw = (nodeId: number, kind: number, v: string, over: Partial<NodeStatus> = {}) => {
  const [fwMajor, fwMinor, fwPatch] = v.split('.').map(Number)
  return nodeStatus(nodeId, { nodeKind: kind, fwMajor, fwMinor, fwPatch, bootloader: 1, ...over })
}

/**
 * The Gateway on 1.0.1. PDU_Left came up in its bootloader (it reports 0.0.0). Left_Fuel kept
 * restarting after a failed update: its row still carries the old 0.3.0, another major than the
 * Gateway. Left_Throttle has no bootloader and is offline, with the version it last reported.
 */
const BENCH = {
  device: connected(gateway({ fwMajor: 1, fwMinor: 0, fwPatch: 1, bootloader: 1 })),
  model: model([
    pdu(3, 'PDU_Left', { status: fw(3, 2, '0.0.0', { bootState: BOOT_STATE.APP_INVALID }) }),
    panel(10, 'Left_Throttle', { ...offline(1), status: fw(10, 1, '1.0.0', { bootloader: 0 }) }),
    panel(11, 'Left_Fuel', { status: fw(11, 1, '0.3.0', { bootState: BOOT_STATE.APP_UNSTABLE }) })
  ]),
  firmware: { release: savedRelease('1.0.1') }
}

const attentionRows = () => screen.queryAllByRole('listitem').map((li) => li.textContent)
const tile = (id: number, name: string) => screen.getByTitle(new RegExp(`^#${id} ${name}`))

describe('T43 a board its bootloader holds (#175)', () => {
  it('Attention: one item each, first, no mismatch for the old version; the cog opens the Firmware sheet', async () => {
    const { user } = await renderScenario(<Cockpit />, BENCH)
    const rows = attentionRows()
    expect(rows.slice(0, 2)).toEqual([
      expect.stringMatching(/PDU_LeftNEEDS FIRMWARE · #3$/),
      expect.stringMatching(/Left_FuelWON’T START · #11$/)
    ])
    expect(rows.join('\n')).not.toMatch(/reflash it/)
    expect(tile(11, 'Left_Fuel').title).not.toMatch(/FW MISMATCH/)
    await user.click(screen.getByRole('button', { name: 'PDU_Left firmware' }))
    expect(screen.getByRole('dialog', { name: 'Firmware' })).toBeInTheDocument()
  })

  it('Status › Firmware: the chip beside the version, and the note instead of the not-reported hint', async () => {
    const { user } = await renderScenario(<Cockpit />, BENCH)
    // A PDU opens from its Firmware sheet row.
    await user.click(screen.getByRole('button', { name: /^Firmware/ }))
    await user.click(screen.getByRole('button', { name: 'Open PDU_Left · #3' }))
    const sheet = screen.getByRole('dialog', { name: /PDU_Left/ })
    expect(within(sheet).getByText('Installed').parentElement).toHaveTextContent(
      'Installedversion not reportedNEEDS FIRMWARE'
    )
    expect(
      within(sheet).getByText('The last update didn’t finish. Update it again.')
    ).toBeInTheDocument()
    expect(within(sheet).queryByText(/reported its firmware version/)).toBeNull()
  })

  it('no image in the release: the chip only, and no mismatch box', async () => {
    const { user } = await renderScenario(<Cockpit />, BENCH)
    await user.click(tile(11, 'Left_Fuel'))
    const sheet = screen.getByRole('dialog', { name: 'Panel group Left_Fuel' })
    const section = within(sheet).getByText('Installed').closest('.sh__sec')!
    expect(section.textContent).toBe('FirmwareInstalled0.3.0WON’T START')
    expect(within(sheet).queryByText('Firmware mismatch')).toBeNull()
  })

  it('no bootloader, offline with the version it last reported: the box and its docs link', async () => {
    const { user } = await renderScenario(<Cockpit />, BENCH)
    await user.click(tile(10, 'Left_Throttle'))
    const sheet = screen.getByRole('dialog', { name: 'Panel group Left_Throttle' })
    expect(within(sheet).getByText('No bootloader').parentElement).toHaveTextContent(
      'this board can’t be updated from here. Flash it once with a programmer'
    )
    expect(within(sheet).getByRole('link', { name: 'About the bootloader ↗' })).toHaveAttribute(
      'href',
      'https://openskyhawk.github.io/OpenSkyhawk/firmware/bootloader/'
    )
  })
})
