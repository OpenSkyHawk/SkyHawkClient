// T8 — the board panel footer, for a PDU: what Forget and Hide do to the boards it feeds.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import type { NodeModel } from '@shared/node-rules'
import { Cockpit } from '../src/tabs/Cockpit'
import { renderScenario } from './render'
import { connected, model, offline, panel, pdu } from './scenarios'

/**
 * PDU_Right (#4), offline, feeds Right_Navigation (#2, offline) and Right_TACAN (#7, online) on the
 * plan, and Right_Radar (#8), which is hidden — so not in the model's boards.
 */
const scene = (over: Partial<NodeModel> = {}) =>
  model(
    [
      panel(2, 'Right_Navigation', { pduId: 4, ...offline() }),
      pdu(4, 'PDU_Right', offline()),
      panel(7, 'Right_TACAN', { pduId: 4 })
    ],
    [],
    {
      hidden: [8],
      hiddenNodes: [{ nodeId: 8, name: 'Right_Radar', console: 'Right' }],
      ...over
    }
  )

/** PDU_Right's panel, open on its Settings tab. */
async function openSettings(m: NodeModel) {
  const r = await renderScenario(<Cockpit />, { device: connected(), model: m })
  await r.user.click(screen.getByTitle('PDU_Right — power zone details'))
  const sheet = screen.getByRole('dialog', { name: 'PDU PDU_Right' })
  await r.user.click(within(sheet).getByRole('tab', { name: 'Settings' }))
  const button = (name: string) => within(sheet).getByRole('button', { name })
  return { ...r, sheet, button }
}

describe('T8 Board panel footer: PDU (B73, B9, B10, X8)', () => {
  it('offline: Forget unlinks "Its 2 boards", Hide keeps the links', async () => {
    const { sheet, button } = await openSettings(scene())
    expect(button('Forget')).toBeEnabled()
    expect(button('Forget')).toHaveAttribute(
      'title',
      'Remove it from your cockpit; its boards lose the link'
    )
    expect(button('Hide')).toBeEnabled()
    expect(button('Hide')).toHaveAttribute(
      'title',
      'Hide until it reports again; its boards keep the link'
    )
    expect(
      within(sheet).getByText(
        'Forget removes this PDU from your cockpit. Its 2 boards move to No power zone and keep no link to it, even if it comes back. Hide keeps the links: they return under it when it reports.'
      )
    ).toBeInTheDocument()
  })

  it('the fed count is the boards on the plan, not the hidden one (X8 today)', async () => {
    // contract X8: main's Forget unlinks every board the PDU feeds, hidden ones included (here 3);
    // today the footer and Feeds count only the visible boards in your cockpit (2).
    const { sheet, user } = await openSettings(scene())
    expect(within(sheet).getByText(/^Forget removes this PDU/)).toHaveTextContent('Its 2 boards')
    const feeds = within(sheet).getByRole('tab', { name: 'Feeds · 2' })
    await user.click(feeds)
    expect(within(sheet).getByRole('button', { name: 'Open Right_Navigation' })).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Open Right_TACAN' })).toBeInTheDocument()
    expect(within(sheet).queryByText('Right_Radar')).toBeNull()
  })

  it('a PDU feeding nothing: the note leaves the boards out', async () => {
    const { sheet } = await openSettings(model([pdu(4, 'PDU_Right', offline())]))
    expect(
      within(sheet).getByText(
        'Forget removes this PDU from your cockpit. Hide keeps the links: they return under it when it reports.'
      )
    ).toBeInTheDocument()
  })

  it('online: Forget and Hide are greyed out, with the reason', async () => {
    const online =
      'Online — it’s active on the bus, so it can’t be removed. Forget and Hide work once it’s offline.'
    const { sheet, button } = await openSettings(model([pdu(4, 'PDU_Right')]))
    expect(button('Forget')).toBeDisabled()
    expect(button('Hide')).toBeDisabled()
    expect(button('Hide')).toHaveAttribute('title', online)
    expect(within(sheet).getByText(online)).toBeInTheDocument()
  })

  it('Hide asks main to hide the PDU; Forget asks main to forget it', async () => {
    const hide = await openSettings(scene())
    await hide.user.click(hide.button('Hide'))
    expect(hide.sky.hideNode).toHaveBeenCalledWith(4, true)
    expect(screen.queryByRole('dialog')).toBeNull()
    hide.unmount()

    const forget = await openSettings(scene())
    await forget.user.click(forget.button('Forget'))
    expect(forget.sky.forgetNode).toHaveBeenCalledWith(4)
  })

  it('Reset to default restores the name and console only', async () => {
    const { button } = await openSettings(
      model([pdu(4, 'PDU_Right', { ...offline(), differs: true })])
    )
    expect(button('Reset to default')).toBeEnabled()
    expect(button('Reset to default')).toHaveAttribute(
      'title',
      'Restore the name and console from NODE_IDS.md'
    )
  })
})
