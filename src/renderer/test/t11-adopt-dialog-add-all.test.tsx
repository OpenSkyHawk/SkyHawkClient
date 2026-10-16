// T11 — the Adopt dialog: "Add all", the Powered by choices, and a board power-cycled to identify it.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import type { NodeModel, NodeModelEntry } from '@shared/node-rules'
import { Cockpit } from '../src/tabs/Cockpit'
import { renderScenario, settle } from './render'
import { connected, model, newBoard, pdu } from './scenarios'

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0)

/** A NODE_IDS.md board on the bus, not added yet, identified as `kind`. */
const waiting = (
  nodeId: number,
  name: string,
  console: string,
  pduId: number | null,
  over: Partial<NodeModelEntry> = {}
) =>
  newBoard(nodeId, T0 + nodeId, {
    name,
    identified: 'panel',
    registry: { name, console, pduId },
    ...over
  })

/** PDU_Left (#3) and PDU_Right (#4) are in your cockpit; PDU_Right_Aft (#5) is not. */
const PDU_LEFT = pdu(3, 'PDU_Left', { console: 'Left' })
const PDU_RIGHT = pdu(4, 'PDU_Right', { console: 'Right' })
const NAV = waiting(2, 'Right_Navigation', 'Right', 4)
const TACAN = waiting(7, 'Right_TACAN', 'Right', 5, {
  registry: { name: 'Right_TACAN', console: 'Right', pduId: 5, pduName: 'PDU_Right_Aft' }
})
const PDU_CENTER = waiting(6, 'PDU_Center', 'Center', null, { kind: 'pdu', identified: 'pdu' })

/** The Cockpit, the Adopt dialog open from "New on the bus · N". */
async function openAdopt(m: NodeModel) {
  const r = await renderScenario(<Cockpit />, { device: connected(), model: m })
  await r.user.click(screen.getByRole('button', { name: 'Adopt…' }))
  const dlg = screen.getByRole('dialog', { name: 'Adopt new devices' })
  const queue = within(dlg).getByRole('listbox', { name: 'New NODE_IDs' })
  const pick = (id: number) =>
    r.user.click(within(queue).getByRole('option', { name: new RegExp(`^NODE_ID ${id}(?!\\d)`) }))
  const options = () => within(queue).getAllByRole('option')
  const zoneChoices = () =>
    within(within(dlg).getByLabelText('Powered by'))
      .getAllByRole('option')
      .map((o) => o.textContent)
  const addAll = async (n: number) => {
    await r.user.click(
      within(dlg).getByRole('button', { name: `Add all ${n} panel groups from NODE_IDS.md` })
    )
    await settle()
  }
  /** The identify row: its dot's symbol (+ reporting, ✕ dropped, none = back) and its text. */
  const ident = () =>
    within(dlg)
      .getByText(/^Not sure which board this is\?/)
      .closest('[role]')
  return { ...r, dlg, pick, options, zoneChoices, addAll, ident }
}

describe('T11 Adopt dialog: Add all, PDU choices, power-cycle (B74, F15, F24, X3)', () => {
  it('Add all takes the NODE_IDS.md panel groups only; a PDU is added on its own', async () => {
    const { sky, addAll, options } = await openAdopt(
      model([PDU_LEFT, PDU_RIGHT, NAV, TACAN, PDU_CENTER])
    )
    await addAll(2)
    expect(sky.adoptNode).toHaveBeenCalledTimes(2)
    expect(sky.adoptNode.mock.calls.map(([id]) => id)).toEqual([2, 7])
    expect(options().map((o) => o.textContent)).toEqual(['NODE_ID 6PDUPDU_Center · in NODE_IDS.md'])
  })

  it('an untouched form keeps its default PDU only when that PDU is in your cockpit, else None', async () => {
    const { sky, addAll } = await openAdopt(model([PDU_LEFT, PDU_RIGHT, NAV, TACAN]))
    await addAll(2)
    expect(sky.adoptNode).toHaveBeenCalledWith(2, {
      name: 'Right_Navigation',
      console: 'Right',
      pduId: 4,
      kind: 'panel'
    })
    expect(sky.adoptNode).toHaveBeenCalledWith(7, {
      name: 'Right_TACAN',
      console: 'Right',
      pduId: null,
      kind: 'panel'
    })
  })

  it('an edited form is taken as written: None stays None', async () => {
    const { dlg, sky, user, addAll } = await openAdopt(model([PDU_LEFT, PDU_RIGHT, NAV, TACAN]))
    // Right_Navigation (first in the queue) is selected: pick None for it.
    await user.selectOptions(within(dlg).getByLabelText('Powered by'), 'None')
    await addAll(2)
    expect(sky.adoptNode).toHaveBeenCalledWith(2, {
      name: 'Right_Navigation',
      console: 'Right',
      pduId: null,
      kind: 'panel'
    })
  })

  it('an edited form keeps a PDU that isn’t in your cockpit (D7 today)', async () => {
    // contract D7 / F24: zones go only to PDUs in your cockpit, so an out-of-cockpit default should
    // become None; today an edited form keeps the "(not added)" PDU and Add all sends it as is.
    const { dlg, sky, user, pick, addAll } = await openAdopt(
      model([PDU_LEFT, PDU_RIGHT, NAV, TACAN])
    )
    await pick(7)
    const name = within(dlg).getByLabelText('Name')
    await user.clear(name)
    await user.type(name, 'Right_TACAN_2')
    await addAll(2)
    expect(sky.adoptNode).toHaveBeenCalledWith(7, {
      name: 'Right_TACAN_2',
      console: 'Right',
      pduId: 5,
      kind: 'panel'
    })
  })

  it('Powered by: the console’s PDUs, "(other console)" and "(not added)" (D7 today)', async () => {
    // contract D7: only PDUs in your cockpit are offered; today a default PDU that isn't added yet
    // is offered as "(not added)", and the form says the board moves under it once it's added.
    const RADAR = waiting(8, 'Right_Radar', 'Right', 3)
    const { dlg, pick, zoneChoices } = await openAdopt(
      model([PDU_LEFT, PDU_RIGHT, NAV, TACAN, RADAR])
    )
    await pick(8)
    expect(within(dlg).getByLabelText('Powered by')).toHaveDisplayValue('PDU_Left (other console)')
    expect(zoneChoices()).toEqual(['Choose…', 'None', 'PDU_Right', 'PDU_Left (other console)'])

    await pick(7)
    expect(within(dlg).getByLabelText('Powered by')).toHaveDisplayValue('PDU_Right_Aft (not added)')
    expect(zoneChoices()).toEqual(['Choose…', 'None', 'PDU_Right', 'PDU_Right_Aft (not added)'])
    expect(
      within(dlg).getByText(
        'PDU_Right_Aft isn’t in your cockpit yet. Keep it and this board moves under it once it’s added, or pick None.'
      )
    ).toBeInTheDocument()
  })

  it('a hidden PDU in your cockpit reads "(not added)", and Add all drops its link (#95 bug 2 today)', async () => {
    // contract X3 / F15: a hidden board is still in your cockpit, so its boards should keep the
    // link; today the dialog sees only the boards on the plan, so a hidden PDU is "(not added)"
    // and Add all sends None for it.
    const nav = waiting(2, 'Right_Navigation', 'Right', 4, {
      registry: { name: 'Right_Navigation', console: 'Right', pduId: 4, pduName: 'PDU_Right' }
    })
    const radio = waiting(9, 'Right_Radio', 'Right', 4, {
      registry: { name: 'Right_Radio', console: 'Right', pduId: 4, pduName: 'PDU_Right' }
    })
    const { dlg, sky, zoneChoices, addAll } = await openAdopt(
      model([PDU_LEFT, nav, radio], [], {
        hidden: [4],
        hiddenNodes: [{ nodeId: 4, name: 'PDU_Right', console: 'Right' }]
      })
    )
    expect(within(dlg).getByLabelText('Powered by')).toHaveDisplayValue('PDU_Right (not added)')
    expect(zoneChoices()).toEqual(['Choose…', 'None', 'PDU_Right (not added)'])
    await addAll(2)
    expect(sky.adoptNode).toHaveBeenCalledWith(2, {
      name: 'Right_Navigation',
      console: 'Right',
      pduId: null,
      kind: 'panel'
    })
    expect(sky.adoptNode).toHaveBeenCalledWith(9, expect.objectContaining({ pduId: null }))
  })

  it('a board power-cycled while the dialog is open stays listed, red, keeping its form; green when back', async () => {
    const { dlg, sky, user, options, ident } = await openAdopt(
      model([PDU_LEFT, PDU_RIGHT, NAV, TACAN])
    )
    const name = within(dlg).getByLabelText('Name')
    await user.clear(name)
    await user.type(name, 'Nav_Test')
    // Reporting: the identify dot is blue (+).
    expect(ident()).toHaveTextContent(/^\+Not sure which board this is\?/)
    expect(within(dlg).getByText(/^status only · up /)).toBeInTheDocument()

    // It drops off the bus: a registry board not added yet leaves the model.
    sky.emitScenario({ model: model([PDU_LEFT, PDU_RIGHT, TACAN]) })
    expect(options()).toHaveLength(2)
    expect(options()[0]).toHaveTextContent(/^NODE_ID 2(?!\d)/)
    expect(options()[0]).toHaveAttribute('aria-selected', 'true')
    expect(ident()).toHaveTextContent(/^✕Not sure which board this is\?/)
    expect(within(dlg).getByText('not reporting right now')).toBeInTheDocument()
    expect(within(dlg).getByLabelText('Name')).toHaveValue('Nav_Test')

    // Back on the bus: green (no symbol), the typed name still there.
    sky.emitScenario({ model: model([PDU_LEFT, PDU_RIGHT, NAV, TACAN]) })
    expect(ident()).toHaveTextContent(/^Not sure which board this is\?/)
    expect(within(dlg).getByLabelText('Name')).toHaveValue('Nav_Test')
  })
})
