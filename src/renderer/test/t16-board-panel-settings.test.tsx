// T16 — the board panel's Settings tab: display name, console and power zone, and what Save sends.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import type { NodeRegistryInfo } from '@shared/nodes/ipc'
import { Cockpit } from '../src/tabs/Cockpit'
import { renderScenario, settle } from './render'
import { connected, model, newBoard, panel, pdu } from './scenarios'

/**
 * In your cockpit: PDU_Left (#3, Left), PDU_Right (#4) and PDU_Right_Aft (#5) on the Right,
 * PDU_Center (#6). Right_Navigation (#2) is fed by PDU_Right; Right_Radar (#8) by PDU_Left, on
 * another console. A PDU on the bus not added yet (#41) is on the Right too.
 */
const scene = () =>
  model([
    pdu(3, 'PDU_Left', { console: 'Left' }),
    pdu(4, 'PDU_Right', { console: 'Right' }),
    pdu(5, 'PDU_Right_Aft', { console: 'Right' }),
    pdu(6, 'PDU_Center', { console: 'Center' }),
    panel(2, 'Right_Navigation', { pduId: 4 }),
    panel(8, 'Right_Radar', { pduId: 3 }),
    newBoard(41, 0, { name: 'PDU_Right_Fwd', kind: 'pdu', identified: 'pdu', console: 'Right' })
  ])

const registry: NodeRegistryInfo = {
  file: 'Firmware/NODE_IDS.md',
  commit: 'abc1234',
  date: '2026-10-01',
  nodes: [
    { nodeId: 2, name: 'Right_Navigation', console: 'Right', kind: 'panel' },
    { nodeId: 4, name: 'PDU_Right', console: 'Right', kind: 'pdu' }
  ]
}

/** The Cockpit with a board's panel open on its Settings tab. */
async function openSettings(open: () => HTMLElement, sheetName: string, m = scene()) {
  const r = await renderScenario(<Cockpit />, { device: connected(), model: m, registry })
  await r.user.click(open())
  const sheet = screen.getByRole('dialog', { name: sheetName })
  await r.user.click(within(sheet).getByRole('tab', { name: 'Settings' }))
  await settle()
  const field = (label: string) => within(sheet).queryByLabelText(label)
  const choices = (label: string) =>
    within(field(label)!)
      .getAllByRole('option')
      .map((o) => o.textContent)
  const save = async () => {
    await r.user.click(within(sheet).getByRole('button', { name: 'Save' }))
    await settle()
  }
  return { ...r, sheet, field, choices, save }
}

const panelGroup = (id: number, name: string, m = scene()) =>
  openSettings(() => screen.getByTitle(new RegExp(`^#${id} ${name}`)), `Panel group ${name}`, m)

describe('T16 Board panel Settings tab (B72, X2)', () => {
  it('the display name, where its defaults come from, and the placement', async () => {
    const { sheet, field } = await panelGroup(2, 'Right_Navigation')
    expect(field('Display name')).toHaveValue('Right_Navigation')
    expect(
      within(sheet).getByText('Registry: Right_Navigation, Right console (NODE_IDS.md).')
    ).toBeInTheDocument()
    expect(field('Console')).toHaveDisplayValue('Right console')
    expect(field('Power zone')).toHaveDisplayValue('PDU_Right')
  })

  it('Power zone offers the console’s PDUs in your cockpit and None — not a new PDU', async () => {
    const { choices } = await panelGroup(2, 'Right_Navigation')
    expect(choices('Power zone')).toEqual(['None', 'PDU_Right', 'PDU_Right_Aft'])
  })

  it('a zone on another console is listed "(other console)" until changed', async () => {
    const { field, choices } = await panelGroup(8, 'Right_Radar')
    expect(field('Power zone')).toHaveDisplayValue('PDU_Left (other console)')
    expect(choices('Power zone')).toEqual([
      'None',
      'PDU_Right',
      'PDU_Right_Aft',
      'PDU_Left (other console)'
    ])
  })

  it('picking a console picks its first PDU', async () => {
    const { user, field, choices } = await panelGroup(2, 'Right_Navigation')
    await user.selectOptions(field('Console')!, 'Left')
    expect(field('Power zone')).toHaveDisplayValue('PDU_Left')
    expect(choices('Power zone')).toEqual(['None', 'PDU_Left'])
    await user.selectOptions(field('Console')!, 'Center')
    expect(field('Power zone')).toHaveDisplayValue('PDU_Center')
  })

  it('Save sends only what changed, and the panel closes', async () => {
    const { sky, user, field, save } = await panelGroup(2, 'Right_Navigation')
    await user.selectOptions(field('Console')!, 'Left')
    await save()
    expect(sky.setNodeMapping).toHaveBeenCalledWith(2, { console: 'Left', pduId: 3 })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a new name alone is all Save sends', async () => {
    const { sky, user, field, save } = await panelGroup(2, 'Right_Navigation')
    await user.clear(field('Display name')!)
    await user.type(field('Display name')!, '  Nav  ')
    await save()
    expect(sky.setNodeMapping).toHaveBeenCalledWith(2, { name: 'Nav' })
  })

  it('Save with no change just closes', async () => {
    const { sky, save } = await panelGroup(2, 'Right_Navigation')
    await save()
    expect(sky.setNodeMapping).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('an empty name: main refuses it, the error shows inline and the panel stays open', async () => {
    // contract B72: an empty name gives an inline error; today the panel has no check of its own —
    // it sends the empty name and shows main's refusal.
    const { sky, sheet, user, field, save } = await panelGroup(2, 'Right_Navigation')
    sky.setNodeMapping.mockResolvedValueOnce({ ok: false, error: 'Name cannot be empty' })
    await user.clear(field('Display name')!)
    await save()
    expect(sky.setNodeMapping).toHaveBeenCalledWith(2, { name: '' })
    expect(within(sheet).getByText('Name cannot be empty')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Panel group Right_Navigation' })).toBeInTheDocument()
  })

  it('a PDU renames and moves console, and never takes a power zone', async () => {
    const { sky, sheet, user, field, save } = await openSettings(
      () => screen.getByTitle('PDU_Right — power zone details'),
      'PDU PDU_Right'
    )
    expect(field('Power zone')).toBeNull()
    expect(field('Powered by')).toBeNull()
    expect(
      within(sheet).getByText(
        'A PDU has no power zone. Moving it to another console moves its group, and the boards it powers, with it on the plan.'
      )
    ).toBeInTheDocument()
    await user.selectOptions(field('Console')!, 'Left')
    await save()
    expect(sky.setNodeMapping).toHaveBeenCalledWith(4, { console: 'Left' })
  })
})
