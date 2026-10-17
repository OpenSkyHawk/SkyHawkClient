// T7 — the board panel footer, for a panel group: Save · Reset to default | Forget · Hide.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import type { NodeModelEntry } from '@shared/nodes'
import { Cockpit } from '../src/tabs/Cockpit'
import { renderScenario } from './render'
import { connected, model, noStatusYet, offline, panel } from './scenarios'

const ONLINE =
  'Online — it’s active on the bus, so it can’t be removed. Forget and Hide work once it’s offline.'
const NO_ROSTER =
  'No roster yet — connect the Gateway. Forget and Hide work once the board shows offline.'

/** Right_Navigation (#2) on the Cockpit; its panel open on the Settings tab. */
async function openSettings(over: Partial<NodeModelEntry>) {
  const r = await renderScenario(<Cockpit />, {
    device: connected(),
    model: model([panel(2, 'Right_Navigation', over)])
  })
  await r.user.click(screen.getByTitle(/^#2 Right_Navigation/))
  const sheet = screen.getByRole('dialog', { name: 'Panel group Right_Navigation' })
  await r.user.click(within(sheet).getByRole('tab', { name: 'Settings' }))
  const button = (name: string) => within(sheet).queryByRole('button', { name })
  return { ...r, sheet, button }
}

describe('T7 Board panel footer: panel group (B73, X4)', () => {
  it('offline: Forget and Hide are enabled, and the note says where a forgotten board comes back', async () => {
    const { sheet, button } = await openSettings(offline())
    expect(button('Save')).toBeEnabled()
    expect(button('Forget')).toBeEnabled()
    expect(button('Forget')).toHaveAttribute(
      'title',
      'Remove it from your cockpit and the saved mapping'
    )
    expect(button('Hide')).toBeEnabled()
    expect(button('Hide')).toHaveAttribute('title', 'Hide until it reports again')
    expect(
      within(sheet).getByText(
        'Forget removes it from your cockpit and the saved mapping; if it reports again it waits in New on the bus, pre-filled from NODE_IDS.md. Hide takes it off the Cockpit until it reports again.'
      )
    ).toBeInTheDocument()
  })

  it('online: Forget and Hide are greyed out, with the reason', async () => {
    const { sheet, button } = await openSettings({})
    expect(button('Forget')).toBeDisabled()
    expect(button('Forget')).toHaveAttribute('title', ONLINE)
    expect(button('Hide')).toBeDisabled()
    expect(button('Hide')).toHaveAttribute('title', ONLINE)
    expect(within(sheet).getByText(ONLINE)).toBeInTheDocument()
  })

  it('no roster yet: Forget and Hide are greyed out until it shows offline (X4 today)', async () => {
    // contract X4: main accepts Forget/Hide whenever the roster doesn't list the board present,
    // `unknown` included (F3); today the footer allows them only once it is `offline`.
    const { sheet, button } = await openSettings(noStatusYet())
    expect(button('Forget')).toBeDisabled()
    expect(button('Forget')).toHaveAttribute('title', NO_ROSTER)
    expect(button('Hide')).toBeDisabled()
    expect(within(sheet).getByText(NO_ROSTER)).toBeInTheDocument()
  })

  it('Reset to default is greyed out at the NODE_IDS.md defaults, and resets when it differs', async () => {
    const atDefaults = await openSettings(offline())
    expect(atDefaults.button('Reset to default')).toBeDisabled()
    expect(atDefaults.button('Reset to default')).toHaveAttribute(
      'title',
      'Already at the NODE_IDS.md defaults'
    )
    atDefaults.unmount()

    const { sky, user, button } = await openSettings({ ...offline(), differs: true })
    expect(button('Reset to default')).toBeEnabled()
    expect(button('Reset to default')).toHaveAttribute(
      'title',
      'Restore the name, console and power zone from NODE_IDS.md'
    )
    await user.click(button('Reset to default')!)
    expect(sky.resetNode).toHaveBeenCalledWith(2)
    // Main accepted it: the panel closes.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('an adopted board has no Reset, and comes back as new', async () => {
    const { sheet, button } = await openSettings({ ...offline(), source: 'adopted' })
    expect(button('Reset to default')).toBeNull()
    expect(
      within(sheet).getByText(
        'Forget removes it from your cockpit and the saved mapping; if it reports again it shows as new. Hide takes it off the Cockpit until it reports again.'
      )
    ).toBeInTheDocument()
  })

  it('Forget asks main to forget it; the panel closes when main accepts', async () => {
    const { sky, user, button } = await openSettings(offline())
    await user.click(button('Forget')!)
    expect(sky.forgetNode).toHaveBeenCalledWith(2)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a refused Forget shows main’s error and keeps the panel open', async () => {
    const { sky, sheet, user, button } = await openSettings(offline())
    sky.forgetNode.mockResolvedValueOnce({
      ok: false,
      error: 'It is online — a board on the bus can’t be forgotten'
    })
    await user.click(button('Forget')!)
    expect(
      within(sheet).getByText('It is online — a board on the bus can’t be forgotten')
    ).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Panel group Right_Navigation' })).toBeInTheDocument()
  })

  it('Hide asks main to hide it until it reports again', async () => {
    const { sky, user, button } = await openSettings(offline())
    await user.click(button('Hide')!)
    expect(sky.hideNode).toHaveBeenCalledWith(2, true)
  })
})
