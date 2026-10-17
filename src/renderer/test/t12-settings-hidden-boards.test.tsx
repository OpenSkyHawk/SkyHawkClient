// T12 — Settings › Cockpit › Hidden boards.
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import type { NodeModel } from '@shared/nodes'
import { Settings } from '../src/tabs/Settings'
import { renderScenario, settle } from './render'
import { connected, model, panel } from './scenarios'

const EMPTY = 'No hidden boards. Hide in an offline board’s Cockpit panel lists it here.'

/** Right_Radar (#8) and an adopted board placed on no console (#30, console '') are hidden. */
const twoHidden = () =>
  model([panel(1, 'Center_Armament')], [], {
    hidden: [8, 30],
    hiddenNodes: [
      { nodeId: 8, name: 'Right_Radar', console: 'Right' },
      { nodeId: 30, name: 'Left_Spare', console: '' }
    ]
  })

/** Settings, on its Cockpit section. */
async function openCockpitSection(m: NodeModel) {
  const r = await renderScenario(<Settings />, { device: connected(), model: m })
  await r.user.click(screen.getByRole('button', { name: /^Cockpit/ }))
  await settle()
  const unhideAll = () => screen.getByRole('button', { name: 'Un-hide all' })
  const unhide = () => screen.queryAllByRole('button', { name: 'Un-hide' })
  return { ...r, unhideAll, unhide }
}

/** A Hidden boards row's text, from its "#id". */
const row = (id: number) => screen.getByText(`#${id}`).parentElement

describe('T12 Settings › Cockpit › Hidden boards (B88)', () => {
  it('lists each hidden board: #id, the name and console the Cockpit showed', async () => {
    const { unhide, unhideAll } = await openCockpitSection(twoHidden())
    expect(row(8)).toHaveTextContent('#8Right_RadarRight console · returns when it reports again')
    expect(row(30)).toHaveTextContent('#30Left_Sparereturns when it reports again')
    expect(unhide()).toHaveLength(2)
    expect(unhideAll()).toBeEnabled()
    expect(screen.queryByText(EMPTY)).toBeNull()
  })

  it('Un-hide asks main to show that board again', async () => {
    const { sky, user, unhide } = await openCockpitSection(twoHidden())
    await user.click(unhide()[0]!)
    expect(sky.hideNode).toHaveBeenCalledTimes(1)
    expect(sky.hideNode).toHaveBeenCalledWith(8, false)
  })

  it('Un-hide all un-hides every one', async () => {
    const { sky, user, unhideAll } = await openCockpitSection(twoHidden())
    await user.click(unhideAll())
    await settle()
    expect(sky.hideNode.mock.calls).toEqual([
      [8, false],
      [30, false]
    ])
  })

  it('a refused un-hide shows main’s error', async () => {
    const { sky, user, unhide } = await openCockpitSection(twoHidden())
    sky.hideNode.mockResolvedValueOnce({ ok: false, error: 'Node mapping is read-only' })
    await user.click(unhide()[0]!)
    await settle()
    expect(screen.getByText('Node mapping is read-only')).toBeInTheDocument()
  })

  it('nothing hidden: the empty-state text, and Un-hide all is greyed out', async () => {
    const { unhide, unhideAll } = await openCockpitSection(model([panel(1, 'Center_Armament')]))
    expect(screen.getByText(EMPTY)).toBeInTheDocument()
    expect(unhide()).toHaveLength(0)
    expect(unhideAll()).toBeDisabled()
  })
})
