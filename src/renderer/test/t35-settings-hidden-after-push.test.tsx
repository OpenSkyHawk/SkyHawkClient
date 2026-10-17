// T35 — Settings › Cockpit › Hidden boards follows main's pushes: a hidden board that reports
// again drops off the list. Settings pulls the node data when it mounts (useNodesPulled) and then
// reads main's pushes through the nodes store; this pins the deterministic path only — pull, then
// pushes in order. The pull-vs-push race (C5 / F10) is not pinned.
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { Settings } from '../src/app/settings/Settings'
import { renderScenario, settle } from './render'
import { connected, model, offline, panel } from './scenarios'

const EMPTY = 'No hidden boards. Hide in an offline board’s Cockpit panel lists it here.'

/** Right_Radar (#8) hidden while offline. */
const radarHidden = () =>
  model([panel(1, 'Center_Armament')], [], {
    hidden: [8],
    hiddenNodes: [{ nodeId: 8, name: 'Right_Radar', console: 'Right' }]
  })

async function openCockpit() {
  const r = await renderScenario(<Settings />, { device: connected(), model: radarHidden() })
  await r.user.click(screen.getByRole('button', { name: /^Cockpit/ }))
  await settle()
  return r
}

const unhideButtons = () => screen.queryAllByRole('button', { name: 'Un-hide' })

describe('T35 Settings › Cockpit › Hidden boards after a push (B88, F10)', () => {
  it('a hidden board that reports again drops off the list', async () => {
    const { sky } = await openCockpit()
    expect(screen.getByText('#8')).toBeInTheDocument()
    expect(unhideButtons()).toHaveLength(1)

    // It reports: main clears its hidden flag and pushes it back on the plan.
    sky.emitScenario({ model: model([panel(1, 'Center_Armament'), panel(8, 'Right_Radar')]) })
    expect(screen.queryByText('#8')).toBeNull()
    expect(unhideButtons()).toHaveLength(0)
    expect(screen.getByText(EMPTY)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Un-hide all' })).toBeDisabled()
  })

  it('a board hidden elsewhere (the Cockpit, a config import) appears without reopening Settings', async () => {
    const { sky } = await openCockpit()
    sky.emitScenario({
      model: model([panel(1, 'Center_Armament')], [], {
        hidden: [2, 8],
        hiddenNodes: [
          { nodeId: 2, name: 'Right_Navigation', console: 'Right' },
          { nodeId: 8, name: 'Right_Radar', console: 'Right' }
        ]
      })
    })
    expect(unhideButtons()).toHaveLength(2)
    expect(screen.getByText('#2').parentElement).toHaveTextContent(
      '#2Right_NavigationRight console · returns when it reports again'
    )
  })

  it('the last push wins: hidden, shown, hidden again', async () => {
    const { sky } = await openCockpit()
    sky.emitScenario({ model: model([panel(1, 'Center_Armament'), panel(8, 'Right_Radar')]) })
    expect(screen.queryByText('#8')).toBeNull()
    sky.emitScenario({ model: radarHidden() })
    expect(screen.getByText('#8')).toBeInTheDocument()
  })

  it('a push that still lists it hidden keeps the row', async () => {
    const { sky } = await openCockpit()
    sky.emitScenario({
      model: model([panel(1, 'Center_Armament', offline())], [], {
        hidden: [8],
        hiddenNodes: [{ nodeId: 8, name: 'Right_Radar', console: 'Right' }]
      })
    })
    expect(screen.getByText('#8')).toBeInTheDocument()
  })
})
