// T30 — Settings › Cockpit › Reset node mapping…: the row, and the review before anything resets.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import type { NodeMappingFile, NodeModel } from '@shared/nodes'
import { Settings } from '../src/app/settings/Settings'
import { renderScenario, settle } from './render'
import { connected, model, modelNode, panel, pdu, resetPreview } from './scenarios'

/**
 * node-mapping.json: Right_Navigation (#2) renamed "Nav" and moved to PDU_Left (#3), and Left_Trim
 * (#41) adopted onto the Left console under PDU_Left.
 */
const FILE: NodeMappingFile = {
  version: 4,
  nodes: {
    2: { added: true, name: 'Nav', pduId: 3 },
    3: { added: true },
    41: { added: true, name: 'Left_Trim', console: 'Left', kind: 'panel', pduId: 3 }
  }
}
const adoptedTrim = () =>
  modelNode(41, { name: 'Left_Trim', console: 'Left', pduId: 3, source: 'adopted' })

/** The model main pushes for FILE, as the Cockpit shows it. */
const fileModel = () =>
  model([panel(2, 'Nav', { pduId: 3, differs: true }), pdu(3, 'PDU_Left'), adoptedTrim()], [], {
    differingCount: 1
  })

/** Settings on its Cockpit section; main answers the review for `file`. */
async function openCockpit(m: NodeModel, file: NodeMappingFile = FILE) {
  const r = await renderScenario(<Settings />, { device: connected(), model: m })
  r.sky.previewNodeReset.mockResolvedValue(resetPreview(file))
  await r.user.click(screen.getByRole('button', { name: /^Cockpit/ }))
  await settle()
  const resetBtn = () => screen.getByRole('button', { name: 'Reset…' })
  const rowDesc = () => screen.getByText('Reset node mapping').nextElementSibling!.textContent
  const openReview = async () => {
    await r.user.click(resetBtn())
    await settle()
    return screen.getByRole('dialog', { name: 'Reset node mapping' })
  }
  return { ...r, resetBtn, rowDesc, openReview }
}

/** The review's change rows: `node · field`, old → new. */
const changes = (dlg: HTMLElement) =>
  within(dlg)
    .getAllByText('→')
    .map((arrow) => arrow.parentElement!.textContent)

describe('T30 Settings › Cockpit › Reset… (B89, B24)', () => {
  it('everything matches NODE_IDS.md and nothing is adopted: greyed out', async () => {
    const { resetBtn, rowDesc } = await openCockpit(
      model([panel(1, 'Center_Armament'), pdu(3, 'PDU_Left')])
    )
    expect(rowDesc()).toBe('Every node matches NODE_IDS.md')
    expect(resetBtn()).toBeDisabled()
  })

  it('a board differs: "1 node differs …", and Reset… is enabled', async () => {
    const { resetBtn, rowDesc } = await openCockpit(
      model([panel(2, 'Nav', { differs: true })], [], { differingCount: 1 })
    )
    expect(rowDesc()).toBe(
      '1 node differs from NODE_IDS.md — return them to their registry name, console and PDU'
    )
    expect(resetBtn()).toBeEnabled()
  })

  it('nothing differs but an adopted board is in the Cockpit: enabled (it can be forgotten)', async () => {
    const { resetBtn, rowDesc } = await openCockpit(
      model([panel(1, 'Center_Armament'), adoptedTrim()])
    )
    expect(rowDesc()).toBe('Every node matches NODE_IDS.md')
    expect(resetBtn()).toBeEnabled()
  })

  it('the only adopted board is hidden: enabled (X1, R4: still in your cockpit)', async () => {
    // contract X3: main counts a hidden board as in your cockpit, so Reset offers to forget it,
    // and Reset… is enabled for it like for any adopted board.
    const { resetBtn } = await openCockpit(
      model([panel(1, 'Center_Armament')], [], {
        hidden: [41],
        hiddenNodes: [
          { nodeId: 41, name: 'Left_Trim', console: 'Left', kind: 'panel', source: 'adopted' }
        ]
      })
    )
    expect(resetBtn()).toBeEnabled()
  })

  it('the review lists each field old → new, from main’s preview', async () => {
    const { sky, openReview } = await openCockpit(fileModel())
    const dlg = await openReview()
    expect(sky.previewNodeReset).toHaveBeenCalled()
    expect(within(dlg).getByText('2 changes')).toBeInTheDocument()
    // D7 (#131): its NODE_IDS.md PDU, PDU_Right, is not in your cockpit, so Reset gives it none.
    expect(changes(dlg)).toEqual([
      'Right_Navigation · nameNav→Right_Navigation',
      'Right_Navigation · power zonePDU_Left→—',
      '#41 Left_TrimLeft · PDU_Left→New on the bus'
    ])
    expect(within(dlg).getByText('1 node · not in the registry')).toBeInTheDocument()
    expect(
      within(dlg).getByRole('checkbox', { name: 'Also forget adopted nodes' })
    ).toHaveAttribute('aria-checked', 'false')
    expect(
      within(dlg).getByText('Hidden boards and the power supply are not changed.')
    ).toBeInTheDocument()
    expect(within(dlg).getByRole('button', { name: 'Reset 1 node' })).toBeEnabled()
  })

  it('Reset asks main to reset, keeping adopted boards; the review closes', async () => {
    const { sky, user, openReview } = await openCockpit(fileModel())
    const dlg = await openReview()
    await user.click(within(dlg).getByRole('button', { name: 'Reset 1 node' }))
    await settle()
    expect(sky.resetNodeMapping).toHaveBeenCalledTimes(1)
    expect(sky.resetNodeMapping).toHaveBeenCalledWith({ forgetAdopted: false })
    expect(screen.queryByRole('dialog', { name: 'Reset node mapping' })).toBeNull()
  })

  it('"Also forget adopted" → resetNodeMapping({ forgetAdopted: true })', async () => {
    const { sky, user, openReview } = await openCockpit(fileModel())
    const dlg = await openReview()
    const forget = within(dlg).getByRole('checkbox', { name: 'Also forget adopted nodes' })
    await user.click(forget)
    expect(forget).toHaveAttribute('aria-checked', 'true')
    await user.click(within(dlg).getByRole('button', { name: 'Reset 1 node + forget 1' }))
    await settle()
    expect(sky.resetNodeMapping).toHaveBeenCalledWith({ forgetAdopted: true })
  })

  it('only an adopted board: nothing to reset until "Also forget" is ticked', async () => {
    const file: NodeMappingFile = { version: 4, nodes: { 41: FILE.nodes[41]! } }
    const { sky, user, openReview } = await openCockpit(
      model([panel(1, 'Center_Armament'), adoptedTrim()]),
      file
    )
    const dlg = await openReview()
    expect(
      within(dlg).getByText('None — every registry node already matches NODE_IDS.md.')
    ).toBeInTheDocument()
    expect(within(dlg).getByRole('button', { name: 'Reset' })).toBeDisabled()
    await user.click(within(dlg).getByRole('checkbox', { name: 'Also forget adopted nodes' }))
    await user.click(within(dlg).getByRole('button', { name: 'Forget 1 adopted node' }))
    await settle()
    expect(sky.resetNodeMapping).toHaveBeenCalledWith({ forgetAdopted: true })
  })

  it('a refused reset shows main’s error and keeps the review open', async () => {
    const { sky, user, openReview } = await openCockpit(fileModel())
    sky.resetNodeMapping.mockResolvedValueOnce({ ok: false, error: 'Node mapping is read-only' })
    const dlg = await openReview()
    await user.click(within(dlg).getByRole('button', { name: 'Reset 1 node' }))
    await settle()
    expect(within(dlg).getByText('Node mapping is read-only')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Reset node mapping' })).toBeInTheDocument()
  })

  it('the review asks main again only when the mapping changes, not on every push (R9)', async () => {
    const { sky, openReview } = await openCockpit(fileModel())
    const dlg = await openReview()
    expect(sky.previewNodeReset).toHaveBeenCalledTimes(1)
    // Roster polls and PDU pages push the model and the snapshot again; the mapping is the same.
    sky.emitScenario({ model: fileModel() })
    sky.emitScenario({
      model: model(
        [
          panel(2, 'Nav', { pduId: 3, differs: true, availability: 'offline' }),
          pdu(3, 'PDU_Left'),
          adoptedTrim()
        ],
        [],
        { differingCount: 1 }
      )
    })
    await settle()
    expect(sky.previewNodeReset).toHaveBeenCalledTimes(1)
    // The mapping changes underneath (Nav renamed elsewhere): the review asks again.
    sky.emitScenario({
      model: model(
        [panel(2, 'Nav_2', { pduId: 3, differs: true }), pdu(3, 'PDU_Left'), adoptedTrim()],
        [],
        { differingCount: 1 }
      )
    })
    await settle()
    expect(sky.previewNodeReset).toHaveBeenCalledTimes(2)
    expect(within(dlg).getByRole('button', { name: 'Reset 1 node' })).toBeEnabled()
  })

  it('Cancel closes the review without asking main', async () => {
    const { sky, user, openReview } = await openCockpit(fileModel())
    const dlg = await openReview()
    await user.click(within(dlg).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Reset node mapping' })).toBeNull()
    expect(sky.resetNodeMapping).not.toHaveBeenCalled()
  })
})
