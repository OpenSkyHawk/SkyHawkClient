// T34 — one node model, three surfaces: the Overview, the Cockpit and the Connection tab count the
// same boards the same way — a stray included (D1 / X3, #133).
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { App } from '../src/app/App'
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
  it('one nodes:model push: the same offline and warning counts on every tab, the stray too', async () => {
    const { sky, user } = await renderScenario(<App />, { device: connected() })
    sky.emitScenario({ model: scene() })

    // Overview: 4 of 7 up; 2 offline and 2 warnings — the stray is one up and one warning (D1).
    expect(overview()).toEqual({
      value: '✕4 / 7',
      sub: 'nodes up · — W · 2 PDUs',
      banner: '⚠ 4 nodes need attention — 2 offline (PDU_Right + 1 node) · 2 warnings. Open Cockpit'
    })

    // Cockpit: the same 2 offline, 2 warnings and 1 no status yet.
    await user.click(tab('Cockpit'))
    expect(cockpit()).toEqual(['4/ 7', '2 warning · 2 offline · 1 no status yet'])

    // Connection: 4 up = 2 healthy + 2 warnings, 2 offline — the same numbers, with the stray's row.
    await user.click(tab('Connection'))
    expect(connection()).toEqual(['2', '2', '2'])
    expect(screen.getByText('PDUs · — W').parentElement).toHaveTextContent('2PDUs · — W')
    expect(
      screen.getByRole('button', { name: 'Open NODE_ID 9 in Cockpit' }),
      'a row for the stray'
    ).toBeInTheDocument()
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
    // The stray stays: one warning on every tab.
    expect(overview()).toEqual({
      value: '!6 / 7',
      sub: 'nodes up · — W · 2 PDUs',
      banner: '⚠ 1 node needs attention — 1 warning (NODE_ID 9). Open Cockpit'
    })
    await user.click(tab('Cockpit'))
    expect(cockpit()).toEqual(['6/ 7', '1 warning · 0 offline · 1 no status yet'])
    await user.click(tab('Connection'))
    expect(connection()).toEqual(['5', '1', '0'])
    expect(screen.queryByText('Nothing needs attention.')).toBeNull()
  })
})
