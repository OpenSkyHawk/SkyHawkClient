// T39 — each board's firmware and the major-mismatch warning (#171): the sheet's Firmware section,
// the mismatch on the tile, in the sheet and in Attention, the Gateway's own release on the device
// card and in its popover, and the client-too-old banner on every tab.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import { FIRMWARE_RELEASE } from '@shared/firmware'
import type { NodeStatus } from '@shared/nodes'
import { App } from '../src/app/App'
import { Cockpit } from '../src/app/cockpit/Cockpit'
import { Connection } from '../src/app/connection/Connection'
import { DevicePopover } from '../src/app/titlebar/DevicePopover'
import { useNav } from '../src/app/kit'
import { renderScenario } from './render'
import { connected, gateway, link, model, nodeStatus, panel } from './scenarios'

/** A status row reporting firmware `fw` ([0, 0, 0] = not reported). */
const fw = (nodeId: number, v: [number, number, number], over: Partial<NodeStatus> = {}) =>
  nodeStatus(nodeId, { nodeKind: 1, fwMajor: v[0], fwMinor: v[1], fwPatch: v[2], ...over })

/** The Gateway on firmware `v`: its own row, as main judges it. */
const gw = (v: [number, number, number]) => gateway({ fwMajor: v[0], fwMinor: v[1], fwPatch: v[2] })

const attentionRows = () => screen.queryAllByRole('listitem').map((li) => li.textContent)

/** A board's tile on the plan. */
const tile = (id: number, name: string) => screen.getByTitle(new RegExp(`^#${id} ${name}`))

describe('T39 firmware version and major mismatch (#171)', () => {
  it('the sheet shows the release the board reports, or "version not reported" with why', async () => {
    const { user } = await renderScenario(<Cockpit />, {
      device: connected(gw([1, 0, 0])),
      model: model([
        panel(1, 'Center_Armament', { status: fw(1, [1, 0, 1]) }),
        panel(2, 'Right_Navigation', { status: fw(2, [0, 0, 0]) })
      ])
    })
    await user.click(tile(1, 'Center_Armament'))
    let sheet = screen.getByRole('dialog', { name: 'Panel group Center_Armament' })
    expect(within(sheet).getByText('Installed').parentElement).toHaveTextContent('Installed1.0.1')
    await user.click(within(sheet).getByRole('button', { name: 'Close' }))
    await user.click(tile(2, 'Right_Navigation'))
    sheet = screen.getByRole('dialog', { name: 'Panel group Right_Navigation' })
    expect(within(sheet).getByText('Installed').parentElement).toHaveTextContent(
      'Installedversion not reported'
    )
    expect(
      within(sheet).getByText(/^The board was already running when the Gateway started/)
    ).toBeInTheDocument()
  })

  it('a board on another major: gold ! on the tile, its own Attention item first, a box in its sheet', async () => {
    const { user } = await renderScenario(<Cockpit />, {
      device: connected(gw([1, 0, 0])),
      model: model([
        panel(1, 'Center_Armament', { status: fw(1, [1, 0, 1]) }),
        panel(3, 'Left_Oxygen', { status: fw(3, [1, 0, 1], { overheat: true }) }),
        panel(13, 'Left_Fuel', { status: fw(13, [0, 2, 0]) })
      ])
    })
    // Ahead of the fault list; the board's own fault keeps its item.
    expect(attentionRows()).toEqual([
      '!Left_Fuelruns firmware 0.x, Gateway runs 1.x — reflash it · #13',
      '!Left_OxygenOVERHEAT · #3'
    ])
    expect(screen.getByTitle(/^#13 Left_Fuel/).title).toMatch(/FW MISMATCH/)
    await user.click(screen.getByTitle(/^#13 Left_Fuel/))
    const sheet = screen.getByRole('dialog', { name: 'Panel group Left_Fuel' })
    expect(within(sheet).getByText('Firmware mismatch').parentElement!.textContent).toBe(
      'Firmware mismatch — it runs firmware 0.x, the Gateway runs 1.x — reflash it. Boards on different major versions don’t work together on the bus.'
    )
    // The mismatch is the client's finding: the board says it is healthy.
    expect(within(sheet).getByText('Status', { ignore: 'button' }).parentElement).toHaveTextContent(
      'Statushealthy'
    )
  })

  it('the device card and the popover show the Gateway’s own release', async () => {
    await renderScenario(
      <>
        <Connection />
        <DevicePopover />
      </>,
      { device: connected(gw([0, 0, 0])) }
    )
    expect(screen.getByText('Firmware').parentElement).toHaveTextContent(
      'Firmwarenot reported · shows after the Gateway’s next restart'
    )
  })

  it('popover: the release, and gold when it is newer than this client supports', async () => {
    const next = FIRMWARE_RELEASE.major + 1
    const { user } = await renderScenario(<DevicePopover />, {
      device: connected(gw([next, 0, 0]))
    })
    await user.click(screen.getByRole('button', { expanded: false }))
    const pop = screen.getByRole('dialog', { name: 'Device link' })
    const row = within(pop).getByText('Firmware').parentElement!
    expect(row).toHaveTextContent(`Firmware${next}.0.0 · newer than this client`)
    expect(row.querySelector('.gw--warn')).not.toBeNull()
  })

  it('client too old: a banner under the tabs on every tab while that Gateway is connected', async () => {
    const next = FIRMWARE_RELEASE.major + 1
    const r = await renderScenario(<App />, { device: connected(gw([next, 0, 0])) })
    const banner = () => screen.queryByRole('alert')
    expect(banner()).toHaveTextContent(
      `This client is too old for the Gateway’s firmware. The Gateway runs ${next}.0.0; OpenSkyhawk Client v${__APP_VERSION__} supports firmware ${FIRMWARE_RELEASE.major}.x.`
    )
    expect(within(banner()!).getByRole('link', { name: 'Get the latest client' })).toHaveAttribute(
      'href',
      'https://github.com/OpenSkyHawk/SkyHawkClient/releases'
    )
    await r.user.click(screen.getByRole('tab', { name: 'Cockpit' }))
    expect(banner()).toBeInTheDocument()
    expect(useNav.getState().tab).toBe('cockpit')
  })

  it('no banner on the supported major, nor with no Gateway connected', async () => {
    await renderScenario(<App />, { device: connected(gw([FIRMWARE_RELEASE.major, 9, 9])) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('no banner while the link is down', async () => {
    await renderScenario(<App />, { device: link('no-device') })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
