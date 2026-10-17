// T33 — focus in the modal surfaces: a Settings review dialog and a Cockpit side panel. Both use
// the same handling (useModalFocus); this pins it at each. The CalibrationDialog shares it too but
// has no role="dialog" or accessible name today, so it can't be reached the same way (known gap).
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import type { NodeMappingFile } from '@shared/nodes'
import { Settings } from '../src/tabs/Settings'
import { Cockpit } from '../src/tabs/Cockpit'
import { renderScenario, settle } from './render'
import { connected, model, modelNode, panel, pdu, resetPreview } from './scenarios'

/** Right_Navigation renamed (one reset row) and Left_Trim (#41) adopted: four controls in the review. */
const FILE: NodeMappingFile = {
  version: 3,
  nodes: {
    2: { added: true, name: 'Nav' },
    41: { name: 'Left_Trim', console: 'Left', kind: 'panel' }
  }
}

/** Settings › Cockpit with Reset… focused and clicked: the review open. */
async function openReview() {
  const r = await renderScenario(<Settings />, {
    device: connected(),
    model: model(
      [
        panel(2, 'Nav', { differs: true }),
        modelNode(41, { name: 'Left_Trim', console: 'Left', source: 'adopted' })
      ],
      [],
      { differingCount: 1 }
    )
  })
  r.sky.previewNodeReset.mockResolvedValue(resetPreview(FILE))
  await r.user.click(screen.getByRole('button', { name: /^Cockpit/ }))
  await settle()
  const opener = screen.getByRole('button', { name: 'Reset…' })
  await r.user.click(opener)
  await settle()
  const dlg = screen.getByRole('dialog', { name: 'Reset node mapping' })
  return { ...r, opener, dlg }
}

/** The Cockpit with Right_Navigation's side panel opened from its tile. */
async function openSheet() {
  const r = await renderScenario(<Cockpit />, {
    device: connected(),
    model: model([panel(2, 'Right_Navigation', { pduId: 4 }), pdu(4, 'PDU_Right')])
  })
  const opener = screen.getByTitle(/^#2 Right_Navigation/)
  await r.user.click(opener)
  const sheet = screen.getByRole('dialog', { name: 'Panel group Right_Navigation' })
  return { ...r, opener, sheet }
}

/** The controls Tab moves through inside `box`, in order. */
const tabStops = (box: HTMLElement) => [
  ...box.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )
]

describe('T33 Dialog focus (B76)', () => {
  it('dialog: focus goes to its first control on open', async () => {
    const { dlg } = await openReview()
    expect(within(dlg).getByRole('button', { name: 'Close' })).toHaveFocus()
  })

  it('dialog: Tab goes through its controls and wraps; Shift+Tab wraps back', async () => {
    const { user, dlg } = await openReview()
    const close = within(dlg).getByRole('button', { name: 'Close' })
    const forget = within(dlg).getByRole('checkbox', { name: 'Also forget adopted nodes' })
    const cancel = within(dlg).getByRole('button', { name: 'Cancel' })
    const reset = within(dlg).getByRole('button', { name: 'Reset 1 node' })
    expect(tabStops(dlg)).toEqual([close, forget, cancel, reset])

    await user.tab()
    expect(forget).toHaveFocus()
    await user.tab()
    expect(cancel).toHaveFocus()
    await user.tab()
    expect(reset).toHaveFocus()
    await user.tab()
    expect(close, 'wraps to the first').toHaveFocus()
    await user.tab({ shift: true })
    expect(reset, 'wraps back to the last').toHaveFocus()
  })

  it('dialog: Esc closes it, and focus returns to Reset…', async () => {
    const { user, opener } = await openReview()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Reset node mapping' })).toBeNull()
    expect(opener).toHaveFocus()
  })

  it('dialog: Close closes it, and focus returns to Reset…', async () => {
    const { user, opener, dlg } = await openReview()
    await user.click(within(dlg).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'Reset node mapping' })).toBeNull()
    expect(opener).toHaveFocus()
  })

  it('dialog: a click on the scrim closes it, and focus returns to Reset…', async () => {
    const { user, opener, container } = await openReview()
    // The scrim has no role or name: its class is the only way to reach it.
    await user.click(container.querySelector('.im__scrim')!)
    expect(screen.queryByRole('dialog', { name: 'Reset node mapping' })).toBeNull()
    expect(opener).toHaveFocus()
  })

  it('side panel: focus goes to its first control on open', async () => {
    const { sheet } = await openSheet()
    expect(tabStops(sheet)[0]).toHaveFocus()
    expect(tabStops(sheet)[0]).toHaveTextContent('Close')
  })

  it('side panel: Tab wraps inside it, both ways', async () => {
    const { user, sheet } = await openSheet()
    const stops = tabStops(sheet)
    expect(stops.length).toBeGreaterThan(2)
    for (let i = 1; i < stops.length; i++) {
      await user.tab()
      expect(stops[i]).toHaveFocus()
    }
    await user.tab()
    expect(stops[0], 'wraps to the first').toHaveFocus()
    await user.tab({ shift: true })
    expect(stops.at(-1), 'wraps back to the last').toHaveFocus()
  })

  it('side panel: Esc closes it, and focus returns to the tile', async () => {
    const { user, opener } = await openSheet()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Panel group Right_Navigation' })).toBeNull()
    expect(opener).toHaveFocus()
  })

  it('side panel: Close closes it, and focus returns to the tile', async () => {
    const { user, opener, sheet } = await openSheet()
    await user.click(within(sheet).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'Panel group Right_Navigation' })).toBeNull()
    expect(opener).toHaveFocus()
  })

  it('side panel: a click on the scrim closes it, and focus returns to the tile', async () => {
    const { user, opener, container } = await openSheet()
    // The scrim has no role or name: its class is the only way to reach it.
    await user.click(container.querySelector('.sheet__scrim')!)
    expect(screen.queryByRole('dialog', { name: 'Panel group Right_Navigation' })).toBeNull()
    expect(opener).toHaveFocus()
  })
})
