// T4 — Overview: the new-devices notice.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import { Overview } from '../src/app/overview/Overview'
import { App } from '../src/app/App'
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

/** A PDU on NODE_ID 41, which NODE_IDS.md doesn't list. */
const unregisteredPdu = () => newBoard(41, T0, { kind: 'pdu', identified: 'pdu' })

const notice = () => screen.queryByText(/new devices? on the bus/)?.closest('[role="status"]')

describe('T4 Overview: new-devices notice (B60)', () => {
  it('an identified registry board waits "from NODE_IDS.md, not added to your cockpit yet"', async () => {
    await renderScenario(<Overview />, {
      device: connected(),
      model: model([panel(1, 'Center_Armament'), registryPanel()])
    })
    expect(notice()).toHaveTextContent(
      '1 new device on the bus — 1 panel group from NODE_IDS.md, not added to your cockpit yet.'
    )
    expect(
      within(notice() as HTMLElement).getByRole('button', { name: 'Open Cockpit →' })
    ).toBeInTheDocument()
  })

  it('a board NODE_IDS.md doesn’t list is "not in NODE_IDS.md"; a mix says how many are', async () => {
    const { sky } = await renderScenario(<Overview />, {
      device: connected(),
      model: model([unregisteredPdu()])
    })
    expect(notice()).toHaveTextContent('1 new device on the bus — 1 PDU, not in NODE_IDS.md.')
    sky.emitScenario({ model: model([registryPanel(), unregisteredPdu()]) })
    expect(notice()).toHaveTextContent(
      '2 new devices on the bus — 1 panel group, 1 PDU, not added to your cockpit yet — 1 from NODE_IDS.md.'
    )
  })

  it('a board still identifying, or one that can’t be adopted, is not mentioned', async () => {
    await renderScenario(<Overview />, {
      device: connected(),
      model: model([newBoard(9, T0), newBoard(10, T0, { identified: 'bridge' })])
    })
    expect(notice()).toBeUndefined()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('it is hidden while the link is down', async () => {
    const { sky } = await renderScenario(<Overview />, {
      device: connected(),
      model: model([registryPanel()])
    })
    expect(notice()).toBeTruthy()
    sky.emitScenario({ device: link('no-device') })
    expect(notice()).toBeUndefined()
  })

  it('"Open Cockpit →" opens the Cockpit with the Adopt dialog', async () => {
    const { user } = await renderScenario(<App />, {
      device: connected(),
      model: model([registryPanel()])
    })
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('button', { name: 'Open Cockpit →' }))
    expect(screen.getByRole('tab', { name: 'Cockpit' })).toHaveAttribute('aria-selected', 'true')
    const dlg = screen.getByRole('dialog', { name: 'Adopt new devices' })
    expect(
      within(within(dlg).getByRole('listbox', { name: 'New NODE_IDs' })).getByRole('option', {
        selected: true
      })
    ).toHaveTextContent('NODE_ID 2')
  })
})
