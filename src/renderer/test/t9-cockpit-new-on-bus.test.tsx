// T9 — Cockpit › Attention: the "New on the bus · N / Adopt…" call to action.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import { Cockpit } from '../src/app/cockpit/Cockpit'
import { renderScenario } from './render'
import { connected, link, model, newBoard, panel } from './scenarios'

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0)

/** Right_Navigation from NODE_IDS.md, on the bus and reporting as a panel group, not added yet. */
const registryPanel = () =>
  newBoard(2, T0, {
    name: 'Right_Navigation',
    identified: 'panel',
    registry: { name: 'Right_Navigation', console: 'Right', pduId: null }
  })

/** The CTA's line, or null when it isn't shown. */
const cta = () => screen.queryByText(/^New on the bus · \d+$/)
const adoptButton = () => screen.queryByRole('button', { name: 'Adopt…' })

describe('T9 Cockpit "New on the bus" CTA (B68, F12, X7)', () => {
  it('an identified new board: "New on the bus · 1", "not linked yet" and Adopt…', async () => {
    await renderScenario(<Cockpit />, {
      device: connected(),
      model: model([panel(1, 'Center_Armament'), registryPanel()])
    })
    expect(cta()).toHaveTextContent('New on the bus · 1')
    expect(screen.getByText('not linked yet')).toBeInTheDocument()
    expect(adoptButton()).toBeEnabled()
  })

  it('counts every identified new board, PDUs included', async () => {
    await renderScenario(<Cockpit />, {
      device: connected(),
      model: model([registryPanel(), newBoard(41, T0, { kind: 'pdu', identified: 'pdu' })])
    })
    expect(cta()).toHaveTextContent('New on the bus · 2')
  })

  it('a board still identifying, or one that can’t be adopted, is not counted', async () => {
    await renderScenario(<Cockpit />, {
      device: connected(),
      model: model([newBoard(9, T0), newBoard(10, T0, { identified: 'bridge' })])
    })
    expect(cta()).toBeNull()
    expect(adoptButton()).toBeNull()
  })

  it('goes quiet while the link is down, and returns when it is back (R5, #132)', async () => {
    // contract R5 / F12 (fixed, #132 X2): the CTA counts only boards on the bus now
    // (`onBusNow(live)`), so the last model's new boards are not "on the bus" once the link drops.
    const { sky } = await renderScenario(<Cockpit />, {
      device: connected(),
      model: model([registryPanel()])
    })
    expect(cta()).toHaveTextContent('New on the bus · 1')
    sky.emitScenario({ device: link('no-device') })
    expect(screen.getByText('No live node status — connect the Gateway.')).toBeInTheDocument()
    expect(cta()).toBeNull()
    expect(adoptButton()).toBeNull()
    sky.emitScenario({ device: connected() })
    expect(cta()).toHaveTextContent('New on the bus · 1')
    expect(adoptButton()).toBeEnabled()
  })

  it('Adopt… opens the Adopt dialog on the first board in its queue', async () => {
    const { user } = await renderScenario(<Cockpit />, {
      device: connected(),
      model: model([registryPanel()])
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(adoptButton()!)
    const dlg = screen.getByRole('dialog', { name: 'Adopt new devices' })
    expect(
      within(within(dlg).getByRole('listbox', { name: 'New NODE_IDs' })).getByRole('option', {
        selected: true
      })
    ).toHaveTextContent('NODE_ID 2')
  })
})
