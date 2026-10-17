// T34 — one node model, three surfaces: the Overview, the Cockpit and the Connection tab count the
// same boards the same way — except a stray, which only the Cockpit counts (X1 today).
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { App } from '../src/App'
import { renderScenario } from './render'
import {
  connected,
  model,
  newBoard,
  noStatusYet,
  offline,
  outage,
  panel,
  pdu,
  reported
} from './scenarios'

/**
 * Six boards in your cockpit: Center_Armament (#1) and PDU_Left (#3) healthy, Left_Oxygen (#7)
 * overheating, PDU_Right (#4) down with Right_Navigation (#2), Left_Trim (#8) no status yet. On the
 * bus too: a second Gateway (#9), a stray the Cockpit warns about at once.
 */
const scene = () =>
  model(
    [
      panel(1, 'Center_Armament'),
      panel(2, 'Right_Navigation', { pduId: 4, ...offline() }),
      pdu(3, 'PDU_Left'),
      pdu(4, 'PDU_Right', offline()),
      panel(7, 'Left_Oxygen', { status: reported(7, { overheat: true }) }),
      panel(8, 'Left_Trim', noStatusYet()),
      newBoard(9, 0, { identified: 'bridge' })
    ],
    [outage(4, [2], 1)]
  )

const tab = (name: string) => screen.getByRole('tab', { name })

/** The Overview's Cockpit tile and attention banner. */
function overview() {
  const tile = screen.getByRole('button', { name: /^Cockpit/ })
  return {
    value: tile.children[1]!.textContent,
    sub: tile.children[2]!.textContent,
    banner: screen.queryByRole('status')?.textContent ?? null
  }
}

/** The Cockpit band's Nodes online card: `online/ total`, then its sub-line. */
function cockpit() {
  const label = screen.getByText('Nodes online')
  return [
    label.parentElement!.previousElementSibling!.textContent,
    label.nextElementSibling!.textContent
  ]
}

/** Connection's Connected nodes counts. */
const connection = () =>
  ['healthy', 'warning', 'offline'].map((l) => screen.getByText(l).previousSibling!.textContent)

describe('T34 Overview ↔ Cockpit ↔ Connection agreement (X1, B58, B63, B67)', () => {
  it('one nodes:model push: the same offline and warning counts on every tab, but the stray', async () => {
    const { sky, user } = await renderScenario(<App />, { device: connected() })
    sky.emitScenario({ model: scene() })

    // Overview: 3 of 6 up; 2 offline and 1 warning. The stray is not counted (X1 today).
    expect(overview()).toEqual({
      value: '✕3 / 6',
      sub: 'nodes up · — W · 2 PDUs',
      banner: '⚠ 3 nodes need attention — 2 offline (PDU_Right + 1 node) · 1 warning. Open Cockpit'
    })

    // Cockpit: the same 2 offline and 1 no status yet; the stray adds one up, one warning and one
    // to the total (contract D1 says every tab counts it; today only the Cockpit does — X1).
    await user.click(tab('Cockpit'))
    expect(cockpit()).toEqual(['4/ 7', '2 warning · 2 offline · 1 no status yet'])

    // Connection: 3 up = 2 healthy + 1 warning, 2 offline — the Overview's numbers, no stray.
    await user.click(tab('Connection'))
    expect(connection()).toEqual(['2', '1', '2'])
    expect(screen.getByText('PDUs · — W').parentElement).toHaveTextContent('2PDUs · — W')
    expect(
      screen.queryByRole('button', { name: 'Open Node 9 in Cockpit' }),
      'no row for the stray'
    ).toBeNull()
  })

  it('without the stray, all three agree exactly', async () => {
    const noStray = () => {
      const m = scene()
      return { ...m, nodes: m.nodes.filter((n) => n.nodeId !== 9) }
    }
    const { sky, user } = await renderScenario(<App />, { device: connected() })
    sky.emitScenario({ model: noStray() })
    expect(overview().value).toBe('✕3 / 6')
    await user.click(tab('Cockpit'))
    expect(cockpit()).toEqual(['3/ 6', '1 warning · 2 offline · 1 no status yet'])
    await user.click(tab('Connection'))
    expect(connection()).toEqual(['2', '1', '2'])
  })

  it('the next push moves all three together', async () => {
    const { sky, user } = await renderScenario(<App />, { device: connected(), model: scene() })
    // PDU_Right and Right_Navigation come back; Left_Oxygen cools down.
    sky.emitScenario({
      model: model([
        panel(1, 'Center_Armament'),
        panel(2, 'Right_Navigation', { pduId: 4 }),
        pdu(3, 'PDU_Left'),
        pdu(4, 'PDU_Right'),
        panel(7, 'Left_Oxygen'),
        panel(8, 'Left_Trim', noStatusYet()),
        newBoard(9, 0, { identified: 'bridge' })
      ])
    })
    expect(overview()).toEqual({ value: '5 / 6', sub: 'nodes up · — W · 2 PDUs', banner: null })
    await user.click(tab('Cockpit'))
    expect(cockpit()).toEqual(['6/ 7', '1 warning · 0 offline · 1 no status yet'])
    await user.click(tab('Connection'))
    expect(connection()).toEqual(['5', '0', '0'])
    expect(screen.getByText('Nothing needs attention.')).toBeInTheDocument()
  })
})
