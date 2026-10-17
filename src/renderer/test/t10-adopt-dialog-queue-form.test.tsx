// T10 — the Adopt dialog: its queue, the badges, and the form for each kind of new board.
import { describe, expect, it, vi } from 'vitest'
import { act, screen, within } from '@testing-library/react'
import { Cockpit } from '../src/app/cockpit/Cockpit'
import { useNav } from '../src/app/kit'
import { renderScenario, settle } from './render'
import { connected, model, newBoard, pdu } from './scenarios'

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0)

/**
 * PDU_Left (#3) is in your cockpit. On the bus, not added yet, by when this session first saw them:
 * Left_Oxygen (#8, NODE_IDS.md, a panel group fed by PDU_Left) 2 min ago; an unlisted panel group
 * (#12) and an unlisted PDU (#41) 1 min ago; one still identifying (#9), a second Gateway (#10) and
 * an unknown board type (#13) just now.
 */
const scene = () =>
  model([
    pdu(3, 'PDU_Left', { console: 'Left' }),
    newBoard(13, T0, { identified: 'other' }),
    newBoard(41, T0 - 60_000, { kind: 'pdu', identified: 'pdu' }),
    newBoard(9, T0),
    newBoard(12, T0 - 60_000, { identified: 'panel' }),
    newBoard(10, T0, { identified: 'bridge' }),
    newBoard(8, T0 - 120_000, {
      name: 'Left_Oxygen',
      identified: 'panel',
      registry: { name: 'Left_Oxygen', console: 'Left', pduId: 3 }
    })
  ])

/** The Cockpit with the Adopt dialog opened from "New on the bus · N". */
async function openAdopt() {
  vi.useFakeTimers({ now: T0 })
  const r = await renderScenario(<Cockpit />, { device: connected(), model: scene() })
  await r.user.click(screen.getByRole('button', { name: 'Adopt…' }))
  const dlg = screen.getByRole('dialog', { name: 'Adopt new devices' })
  const queue = within(dlg).getByRole('listbox', { name: 'New NODE_IDs' })
  const options = () =>
    within(queue)
      .getAllByRole('option')
      .map((o) => o.textContent)
  const selected = () => within(queue).getByRole('option', { selected: true })
  const pick = (id: number) =>
    r.user.click(within(queue).getByRole('option', { name: new RegExp(`^NODE_ID ${id}(?!\\d)`) }))
  const button = (name: string) => within(dlg).getByRole('button', { name })
  return { ...r, dlg, options, selected, pick, button }
}

describe('T10 Adopt dialog: queue and form (B74, B21, B22)', () => {
  it('lists every new board, oldest first seen first, then by NODE_ID, with its badge', async () => {
    const { dlg, options } = await openAdopt()
    expect(options()).toEqual([
      'NODE_ID 8PANEL GROUPLeft_Oxygen · from NODE_IDS.md',
      'NODE_ID 12PANEL GROUPfirst seen 1 min ago',
      'NODE_ID 41PDUfirst seen 1 min ago',
      'NODE_ID 9IDENTIFYINGfirst seen just now',
      'NODE_ID 10BRIDGEfirst seen just now',
      'NODE_ID 13UNKNOWN TYPEfirst seen just now'
    ])
    // R10 (#133): the count is the "New on the bus · N" button's (the boards that can be added),
    // not every row listed — it was 6 here, against the button's 3.
    expect(screen.getByText('New on the bus · 3')).toBeInTheDocument()
    expect(
      within(dlg).getByText(
        /^3 boards this computer hasn’t added yet\. Boards in NODE_IDS\.md come pre-filled/
      )
    ).toBeInTheDocument()
  })

  it('a request to open another board while the dialog is open lands on that board (R10)', async () => {
    const { pick, selected } = await openAdopt()
    await pick(12)
    expect(selected()).toHaveTextContent('NODE_ID 12')
    // Another way into a board (Connection's "›", a cog) asks for #41: the dialog starts over on
    // it, as the latest push has it, rather than staying on the board it was showing.
    act(() => useNav.getState().openInCockpit(41))
    const [dlg] = screen.getAllByRole('dialog', { name: 'Adopt new devices' })
    expect(screen.getAllByRole('dialog', { name: 'Adopt new devices' })).toHaveLength(1)
    const queue = within(dlg!).getByRole('listbox', { name: 'New NODE_IDs' })
    expect(within(queue).getByRole('option', { selected: true })).toHaveTextContent('NODE_ID 41')
  })

  it('a registry board comes pre-filled from NODE_IDS.md and is one click to add', async () => {
    const { dlg, sky, user, selected, button } = await openAdopt()
    expect(selected()).toHaveTextContent('NODE_ID 8')
    expect(
      within(dlg).getByText(
        'Pre-filled from NODE_IDS.md. Change anything before adding — it’s saved on this computer.'
      )
    ).toBeInTheDocument()
    expect(within(dlg).getByLabelText('Name')).toHaveValue('Left_Oxygen')
    expect(within(dlg).getByLabelText('Console')).toHaveDisplayValue('Left console')
    expect(within(dlg).getByLabelText('Powered by')).toHaveDisplayValue('PDU_Left')
    expect(within(dlg).getByText('1 of 6')).toBeInTheDocument()
    await user.click(button('Add to cockpit'))
    await settle()
    expect(sky.adoptNode).toHaveBeenCalledWith(8, {
      name: 'Left_Oxygen',
      console: 'Left',
      pduId: 3,
      kind: 'panel'
    })
  })

  it('changing the console clears Powered by: you pick the PDU (N9, as the Settings tab does)', async () => {
    const { dlg, user, button } = await openAdopt()
    const zone = within(dlg).getByLabelText('Powered by')
    expect(zone).toHaveDisplayValue('PDU_Left')
    await user.selectOptions(within(dlg).getByLabelText('Console'), 'Right')
    expect(zone).toHaveDisplayValue('Choose…')
    expect(button('Add to cockpit')).toBeDisabled()
    await user.selectOptions(within(dlg).getByLabelText('Console'), 'Left')
    expect(zone).toHaveDisplayValue('Choose…') // not back to the pre-fill: still yours to pick
  })

  it('after an add the selection moves to the next board, and the added one leaves the queue', async () => {
    const { user, options, selected, button } = await openAdopt()
    await user.click(button('Add to cockpit'))
    await settle()
    expect(selected()).toHaveTextContent('NODE_ID 12')
    expect(options()).toHaveLength(5)
    expect(options()[0]).toMatch(/^NODE_ID 12/)
  })

  it('an unlisted panel group starts blank; Adopt waits for name, console and Powered by', async () => {
    const { dlg, sky, user, pick, button } = await openAdopt()
    await pick(12)
    const adopt = button('Adopt')
    const name = within(dlg).getByLabelText('Name')
    const con = within(dlg).getByLabelText('Console')
    const zone = within(dlg).getByLabelText('Powered by')
    expect(name).toHaveValue('')
    expect(zone).toBeDisabled()
    expect(adopt).toBeDisabled()
    expect(
      within(dlg).getByText(
        'Saved on this computer. To make it permanent for everyone, add NODE_ID 12 to NODE_IDS.md.'
      )
    ).toBeInTheDocument()

    await user.type(name, 'Left_Lights')
    expect(adopt).toBeDisabled()
    await user.selectOptions(con, 'Left')
    expect(zone).toBeEnabled()
    expect(
      within(zone)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['Choose…', 'None', 'PDU_Left'])
    expect(adopt).toBeDisabled()
    await user.selectOptions(zone, 'None')
    expect(adopt).toBeEnabled()
    await user.click(adopt)
    await settle()
    expect(sky.adoptNode).toHaveBeenCalledWith(12, {
      name: 'Left_Lights',
      console: 'Left',
      pduId: null,
      kind: 'panel'
    })
  })

  it('a PDU asks for a name and a console only — no Powered by', async () => {
    const { dlg, sky, user, pick, button } = await openAdopt()
    await pick(41)
    expect(within(dlg).queryByLabelText('Powered by')).toBeNull()
    await user.type(within(dlg).getByLabelText('Name'), 'PDU_Aft')
    expect(button('Adopt')).toBeDisabled()
    await user.selectOptions(within(dlg).getByLabelText('Console'), 'Right')
    await user.click(button('Adopt'))
    await settle()
    expect(sky.adoptNode).toHaveBeenCalledWith(41, {
      name: 'PDU_Aft',
      console: 'Right',
      pduId: null,
      kind: 'pdu'
    })
  })

  it('a board still identifying shows the note, not a form', async () => {
    const { dlg, pick, button } = await openAdopt()
    await pick(9)
    expect(
      within(dlg).getByText(
        'Identifying… waiting for the board to report its type. If it doesn’t within a few seconds, it shows in Attention as an issue.'
      )
    ).toHaveAttribute('role', 'status')
    expect(within(dlg).queryByLabelText('Name')).toBeNull()
    expect(button('Adopt')).toBeDisabled()
  })

  it('a second Gateway and an unknown board type show why they can’t be adopted', async () => {
    const { dlg, pick, button } = await openAdopt()
    await pick(10)
    expect(
      within(dlg).getByText(
        'It reports as a Gateway. A cockpit has one, on NODE_ID 0, so this one can’t be adopted. It stays in Attention as an issue while it’s on the bus.'
      )
    ).toBeInTheDocument()
    expect(within(dlg).queryByLabelText('Name')).toBeNull()
    expect(button('Adopt')).toBeDisabled()

    await pick(13)
    expect(
      within(dlg).getByText(
        'It reports a board type this client doesn’t know (0), so it can’t be adopted. A newer client may know it. It stays in Attention as an issue while it’s on the bus.'
      )
    ).toBeInTheDocument()
    expect(within(dlg).queryByLabelText('Name')).toBeNull()
  })

  it('Later keeps a board queued and moves on; Later on the last one closes the dialog', async () => {
    const { sky, user, pick, selected, options, button } = await openAdopt()
    await pick(9)
    await user.click(button('Later'))
    expect(selected()).toHaveTextContent('NODE_ID 10')
    expect(options()).toHaveLength(6)
    await user.click(button('Later'))
    expect(selected()).toHaveTextContent('NODE_ID 13')
    await user.click(button('Later'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(sky.adoptNode).not.toHaveBeenCalled()
  })

  it('a refused adopt shows main’s error and keeps the board selected', async () => {
    const { dlg, sky, user, selected, button } = await openAdopt()
    sky.adoptNode.mockResolvedValueOnce({ ok: false, error: 'It reports as a PDU' })
    await user.click(button('Add to cockpit'))
    await settle()
    expect(within(dlg).getByText('It reports as a PDU')).toBeInTheDocument()
    expect(selected()).toHaveTextContent('NODE_ID 8')
  })
})
