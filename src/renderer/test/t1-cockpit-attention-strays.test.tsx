// T1 — Cockpit › Attention: strays (new boards on the bus that can't be adopted).
import { describe, expect, it, vi } from 'vitest'
import { act, screen, within } from '@testing-library/react'
import { Cockpit } from '../src/app/cockpit/Cockpit'
import { Overview } from '../src/app/overview/Overview'
import { renderScenario } from './render'
import { connected, link, model, newBoard, panel } from './scenarios'

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0)

/** The Attention card's rows, in order (the only list on the Cockpit with no board events). */
const attentionRows = () => screen.queryAllByRole('listitem').map((li) => li.textContent)

describe('T1 Cockpit › Attention: strays (B66, B65, X1, F26)', () => {
  it('an unidentified new board is nothing at first sight and a warning 5 s later', async () => {
    vi.useFakeTimers({ now: T0 })
    await renderScenario(<Cockpit />, {
      device: connected(),
      model: model([newBoard(9, T0)])
    })
    expect(screen.queryByText(/UNIDENTIFIED/)).toBeNull()
    expect(screen.getByText('Nothing needs attention.')).toBeInTheDocument()
    expect(screen.getByText('0 warning · 0 offline')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(5100)
    })
    expect(attentionRows()).toEqual(['!NODE_ID 9UNIDENTIFIED · can’t be adopted · #9'])
    expect(screen.getByText('1 item')).toBeInTheDocument()
    // The health band counts it: one more board, online, warning.
    expect(screen.getByText('1 warning · 0 offline')).toBeInTheDocument()
  })

  it('a second Gateway (bridge kind) and an unknown board type are strays at once', async () => {
    vi.useFakeTimers({ now: T0 })
    await renderScenario(<Cockpit />, {
      device: connected(),
      model: model([
        newBoard(9, T0, { identified: 'bridge' }),
        newBoard(12, T0, { identified: 'other' })
      ])
    })
    expect(attentionRows()).toEqual([
      '!NODE_ID 9SECOND GATEWAY · can’t be adopted · #9',
      '!NODE_ID 12UNKNOWN BOARD TYPE · can’t be adopted · #12'
    ])
    expect(screen.getByText('2 warning · 0 offline')).toBeInTheDocument()
  })

  it('no strays while the link is down', async () => {
    vi.useFakeTimers({ now: T0 })
    await renderScenario(<Cockpit />, {
      device: link('no-device'),
      model: model([newBoard(9, T0, { identified: 'bridge' })])
    })
    expect(screen.queryByText(/SECOND GATEWAY/)).toBeNull()
    expect(screen.getByText('No live node status — connect the Gateway.')).toBeInTheDocument()
    expect(screen.getByText('0 items')).toBeInTheDocument()
    // Nor in the band's board count.
    expect(screen.getByText('/ 0')).toBeInTheDocument()
  })

  it('a stray’s cog opens the Adopt dialog on that board', async () => {
    vi.useFakeTimers({ now: T0 })
    const { user } = await renderScenario(<Cockpit />, {
      device: connected(),
      model: model([
        // First in the Adopt queue (seen earlier), so the dialog would open on it by default.
        newBoard(8, T0 - 60_000, {
          identified: 'panel',
          registry: { name: 'Left_Oxygen', console: 'Left', pduId: null }
        }),
        newBoard(9, T0, { identified: 'bridge' })
      ])
    })
    await user.click(screen.getByRole('button', { name: 'NODE_ID 9 review' }))
    const dlg = screen.getByRole('dialog', { name: 'Adopt new devices' })
    const selected = within(within(dlg).getByRole('listbox', { name: 'New NODE_IDs' })).getByRole(
      'option',
      { selected: true }
    )
    expect(selected).toHaveTextContent('NODE_ID 9')
    expect(selected).toHaveTextContent('BRIDGE')
    expect(
      within(within(dlg).getByRole('listbox', { name: 'New NODE_IDs' })).getByRole('option', {
        selected: false
      })
    ).toHaveTextContent('NODE_ID 8')
  })

  it('the 5 s grace counts from when it came online, not from first sighting (F26 / S6, #133)', async () => {
    // First listed (absent) a minute ago, online only now: still identifying, a stray 5 s later.
    vi.useFakeTimers({ now: T0 })
    await renderScenario(<Cockpit />, {
      device: connected(),
      model: model([newBoard(9, T0 - 60_000, { onlineSince: T0, reportedAt: T0 })])
    })
    expect(attentionRows()).toEqual([])
    expect(screen.getByText('Nothing needs attention.')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(5100)
    })
    expect(attentionRows()).toEqual(['!NODE_ID 9UNIDENTIFIED · can’t be adopted · #9'])
  })

  it('the Overview counts the same stray (D1 / X3, #133)', async () => {
    // One rule for every tab: the stray is one board up and a warning, as on the Cockpit.
    vi.useFakeTimers({ now: T0 })
    await renderScenario(<Overview />, {
      device: connected(),
      model: model([newBoard(9, T0 - 60_000, { identified: 'bridge' })])
    })
    expect(screen.queryByText('no nodes known')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 node needs attention — 1 warning (NODE_ID 9)'
    )
  })

  it('a healthy board in your cockpit is not a stray', async () => {
    vi.useFakeTimers({ now: T0 })
    await renderScenario(<Cockpit />, {
      device: connected(),
      model: model([panel(1, 'Center_Armament')])
    })
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(screen.getByText('Nothing needs attention.')).toBeInTheDocument()
  })
})
