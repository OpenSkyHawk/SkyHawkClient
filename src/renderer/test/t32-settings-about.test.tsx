// T32 — Settings › About: version, ids, and the node registry with its On the bus column.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import type { NodeModel } from '@shared/nodes'
import { Settings } from '../src/app/settings/Settings'
import pkg from '../../../package.json'
import { renderScenario, settle } from './render'
import { bundledRegistry, connected, link, model, offline, panel, pdu } from './scenarios'

/**
 * On the bus now: Center_Armament (#1) and PDU_Left (#3); PDU_Right (#4) offline; PDU_Center
 * (#5) hidden; Right_Navigation (#2) not reported at all.
 */
const bus = () =>
  model([panel(1, 'Center_Armament'), pdu(3, 'PDU_Left'), pdu(4, 'PDU_Right', offline())], [], {
    hidden: [5],
    hiddenNodes: [
      { nodeId: 5, name: 'PDU_Center', console: 'Center', kind: 'pdu', source: 'registry' }
    ]
  })

/** A settings row's value, by the row's label. */
const value = (label: string) =>
  screen.getByText(label).parentElement!.nextElementSibling!.textContent

async function openAbout(m: NodeModel = bus(), device = connected()) {
  const r = await renderScenario(<Settings />, { device, model: m, registry: bundledRegistry() })
  await r.user.click(screen.getByRole('button', { name: /^About/ }))
  await settle()
  const openRegistry = async () => {
    await r.user.click(screen.getByRole('button', { name: 'View…' }))
    await settle()
    return screen.getByRole('dialog', { name: 'Node registry' })
  }
  return { ...r, openRegistry }
}

/** Each registry row: `#id`, name, console, On the bus. */
const rows = (dlg: HTMLElement) =>
  within(dlg)
    .getAllByText(/^#\d+$/)
    .map((id) => id.parentElement!.textContent)

describe('T32 Settings › About (B92, X7)', () => {
  it('version, app id and licence', async () => {
    await openAbout()
    expect(value('Version')).toBe(`v${pkg.version}`)
    expect(value('App id')).toBe('com.openskyhawk.client')
    expect(value('License')).toBe('GPL-2.0-only')
  })

  it('the registry row: what NODE_IDS.md holds, and its commit', async () => {
    await openAbout()
    expect(
      screen.getByText('NODE_IDS.md · 6 nodes: 3 PDUs, 2 panel groups, Gateway')
    ).toBeInTheDocument()
    expect(value('Node registry')).toBe('a78dd90View…')
  })

  it('the registry dialog: every NODE_ID, the bridge as the Gateway, On the bus from the roster', async () => {
    const { openRegistry } = await openAbout()
    const dlg = await openRegistry()
    expect(within(dlg).getByText('NODE_IDS.md @ a78dd90 · 2026-10-16')).toBeInTheDocument()
    expect(rows(dlg)).toEqual([
      '#0Gateway—serial link',
      '#1Center_ArmamentCenteryes',
      '#2Right_NavigationRight—',
      '#3PDU_LeftLeftyes',
      '#4PDU_RightRightoffline',
      '#5PDU_CenterCenterhidden'
    ])
  })

  it('the dialog follows the next roster push', async () => {
    const { sky, openRegistry } = await openAbout()
    const dlg = await openRegistry()
    sky.emitScenario({
      model: model([panel(1, 'Center_Armament', offline()), panel(2, 'Right_Navigation')])
    })
    expect(rows(dlg).slice(1, 3)).toEqual([
      '#1Center_ArmamentCenteroffline',
      '#2Right_NavigationRightyes'
    ])
  })

  it('unplugged: the Gateway reads "no device", but CAN nodes still read "yes" (R5 today)', async () => {
    // contract X7/R5: on the bus means now; today the CAN rows keep the last roster while the
    // link is down (they ignore it), and only the Gateway row follows the link.
    const { sky, openRegistry } = await openAbout()
    const dlg = await openRegistry()
    sky.emitScenario({ device: link('no-device') })
    expect(rows(dlg).slice(0, 2)).toEqual(['#0Gateway—no device', '#1Center_ArmamentCenteryes'])
  })

  it('opened while unplugged: the same', async () => {
    const { openRegistry } = await openAbout(bus(), link('disconnected'))
    const dlg = await openRegistry()
    expect(rows(dlg).slice(0, 2)).toEqual(['#0Gateway—no device', '#1Center_ArmamentCenteryes'])
  })

  it('Close shuts the dialog', async () => {
    const { user, openRegistry } = await openAbout()
    const dlg = await openRegistry()
    await user.click(within(dlg).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'Node registry' })).toBeNull()
  })
})
