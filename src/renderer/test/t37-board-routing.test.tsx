// T37 — every way into a board (D6 / R3, #131): a board in your cockpit opens its panel, any other
// NODE_ID opens the Adopt dialog on it. Main decides it (`cockpit:snapshot`'s `opens`); the Cockpit
// only follows it, whichever entry point the click came from.
import { describe, expect, it, vi } from 'vitest'
import { act, screen, within } from '@testing-library/react'
import { Cockpit } from '../src/app/cockpit/Cockpit'
import { App } from '../src/app/App'
import { useNav } from '../src/app/kit'
import { renderScenario } from './render'
import { connected, model, newBoard, offline, outage, panel, pdu } from './scenarios'

const T0 = Date.UTC(2026, 9, 17, 12, 0, 0)

/**
 * In your cockpit: PDU_Right (#4) feeding Right_Navigation (#2) and Right_Radar (#8, hidden);
 * Left_Oxygen (#7) offline; PDU_Left (#3) down with Left_Trim (#6). On the bus, not added: an
 * unlisted PDU (#41, first seen 2 min ago — first in the Adopt queue), an unlisted panel group
 * (#12), one still identifying (#9) and a second Gateway (#10).
 */
const scene = (over: { nav?: Parameters<typeof panel>[2] } = {}) =>
  model(
    [
      panel(2, 'Right_Navigation', { pduId: 4, ...over.nav }),
      pdu(3, 'PDU_Left', offline(T0)),
      pdu(4, 'PDU_Right'),
      panel(6, 'Left_Trim', { pduId: 3, ...offline(T0) }),
      panel(7, 'Left_Oxygen', offline(T0)),
      newBoard(41, T0 - 120_000, { kind: 'pdu', identified: 'pdu' }),
      newBoard(12, T0 - 60_000, { identified: 'panel' }),
      newBoard(9, T0),
      newBoard(10, T0, { identified: 'bridge' })
    ],
    [outage(3, [6], 1, T0)],
    {
      hidden: [8],
      hiddenNodes: [
        {
          nodeId: 8,
          name: 'Right_Radar',
          console: 'Right',
          kind: 'panel',
          source: 'registry',
          pduId: 4
        }
      ]
    }
  )

async function cockpit() {
  vi.useFakeTimers({ now: T0 })
  return renderScenario(<Cockpit />, { device: connected(), model: scene() })
}

const sheet = (name: string) => screen.queryByRole('dialog', { name })
const adopt = () => screen.queryByRole('dialog', { name: 'Adopt new devices' })
/** The Adopt dialog's selected row, and every row's text. */
function queue() {
  const list = within(adopt()!).getByRole('listbox', { name: 'New NODE_IDs' })
  return {
    selected: within(list).getByRole('option', { selected: true }),
    first: within(list).getAllByRole('option')[0]!
  }
}
/** Another tab asks the Cockpit to open a board — what Connection's "›" sends. */
const fromAnotherTab = (nodeId: number) =>
  act(() => {
    useNav.getState().openInCockpit(nodeId)
  })

describe('T37 every way into a board follows main’s routing (D6)', () => {
  it('the plan: a tile and a PDU group header open their panels', async () => {
    const { user } = await cockpit()
    await user.click(screen.getByTitle(/^#2 Right_Navigation/))
    expect(sheet('Panel group Right_Navigation')).toBeInTheDocument()
    await user.click(
      within(sheet('Panel group Right_Navigation')!).getByRole('button', { name: 'Close' })
    )
    await user.click(screen.getByTitle('PDU_Right — power zone details'))
    expect(sheet('PDU PDU_Right')).toBeInTheDocument()
    expect(adopt()).toBeNull()
  })

  it('Attention: a board in your cockpit opens its panel, a PDU outage the PDU’s', async () => {
    const { user } = await cockpit()
    await user.click(screen.getByRole('button', { name: 'Left_Oxygen details' }))
    expect(sheet('Panel group Left_Oxygen')).toBeInTheDocument()
    await user.click(
      within(sheet('Panel group Left_Oxygen')!).getByRole('button', { name: 'Close' })
    )
    await user.click(screen.getByRole('button', { name: 'PDU_Left details' }))
    expect(sheet('PDU PDU_Left')).toBeInTheDocument()
    expect(adopt()).toBeNull()
  })

  it('Attention: a board outside your cockpit opens Adopt on it, with its note', async () => {
    const { user } = await cockpit()
    await user.click(screen.getByRole('button', { name: 'NODE_ID 10 review' }))
    expect(screen.queryByRole('dialog', { name: /^Panel group|^PDU / })).toBeNull()
    const { selected, first } = queue()
    expect(selected).toHaveTextContent('NODE_ID 10BRIDGE')
    expect(first).toHaveTextContent('NODE_ID 41')
    expect(within(adopt()!).getByText(/It reports as a Gateway/)).toBeInTheDocument()
  })

  it('Powered by and Feeds open the board they name; a hidden fed board has no Open', async () => {
    const { user } = await cockpit()
    await user.click(screen.getByTitle(/^#2 Right_Navigation/))
    await user.click(screen.getByRole('button', { name: 'Open PDU_Right' }))
    const pduSheet = sheet('PDU PDU_Right')!
    expect(pduSheet).toBeInTheDocument()
    await user.click(within(pduSheet).getByRole('tab', { name: /^Feeds/ }))
    expect(within(pduSheet).queryByRole('button', { name: 'Open Right_Radar' })).toBeNull()
    await user.click(within(pduSheet).getByRole('button', { name: 'Open Right_Navigation' }))
    expect(sheet('Panel group Right_Navigation')).toBeInTheDocument()
    expect(adopt()).toBeNull()
  })

  it('Connection’s "›" opens a board in your cockpit on its panel', async () => {
    vi.useFakeTimers({ now: T0 })
    const { user } = await renderScenario(<App />, { device: connected(), model: scene() })
    await user.click(screen.getByRole('tab', { name: 'Connection' }))
    await user.click(screen.getByRole('button', { name: 'Open Left_Oxygen in Cockpit' }))
    expect(screen.getByRole('tab', { name: 'Cockpit' })).toHaveAttribute('aria-selected', 'true')
    expect(sheet('Panel group Left_Oxygen')).toBeInTheDocument()
    expect(adopt()).toBeNull()
  })

  it('another tab asking for a board outside your cockpit opens Adopt on that row, never a panel', async () => {
    vi.useFakeTimers({ now: T0 })
    await renderScenario(<App />, { device: connected(), model: scene() })
    await fromAnotherTab(12)
    expect(screen.getByRole('tab', { name: 'Cockpit' })).toHaveAttribute('aria-selected', 'true')
    expect(sheet('Panel group Node 12')).toBeNull()
    const { selected, first } = queue()
    expect(selected).toHaveTextContent('NODE_ID 12PANEL GROUP')
    expect(first).toHaveTextContent('NODE_ID 41')
  })

  it('a new PDU opens Adopt on it, not a PDU panel', async () => {
    vi.useFakeTimers({ now: T0 })
    await renderScenario(<App />, { device: connected(), model: scene() })
    await fromAnotherTab(41)
    expect(sheet('PDU Node 41')).toBeNull()
    expect(queue().selected).toHaveTextContent('NODE_ID 41PDU')
  })

  it('a board still identifying opens Adopt on it, showing that it is identifying', async () => {
    vi.useFakeTimers({ now: T0 })
    await renderScenario(<App />, { device: connected(), model: scene() })
    await fromAnotherTab(9)
    expect(sheet('Panel group Node 9')).toBeNull()
    expect(queue().selected).toHaveTextContent('NODE_ID 9IDENTIFYING')
    expect(within(adopt()!).getByText(/^Identifying… waiting for the board/)).toBeInTheDocument()
  })

  it('a hidden board is in your cockpit: it never opens Adopt', async () => {
    vi.useFakeTimers({ now: T0 })
    await renderScenario(<App />, { device: connected(), model: scene() })
    await fromAnotherTab(8)
    expect(screen.getByRole('tab', { name: 'Cockpit' })).toHaveAttribute('aria-selected', 'true')
    expect(adopt()).toBeNull()
  })

  it('a board in your cockpit opened from another tab gets its panel', async () => {
    vi.useFakeTimers({ now: T0 })
    await renderScenario(<App />, { device: connected(), model: scene() })
    await fromAnotherTab(2)
    expect(sheet('Panel group Right_Navigation')).toBeInTheDocument()
    expect(adopt()).toBeNull()
  })

  it('a board that leaves your cockpit while its panel is open: the panel closes', async () => {
    const { user, sky } = await cockpit()
    await user.click(screen.getByTitle(/^#2 Right_Navigation/))
    expect(sheet('Panel group Right_Navigation')).toBeInTheDocument()
    // Forgotten elsewhere (an import, Reset… with "Also forget") while it stays on the bus.
    sky.emitScenario({
      model: model([
        newBoard(2, T0, {
          name: 'Right_Navigation',
          identified: 'panel',
          registry: { name: 'Right_Navigation', console: 'Right', pduId: null }
        })
      ])
    })
    expect(sheet('Panel group Right_Navigation')).toBeNull()
  })
})
