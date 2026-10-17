// T17 — Cockpit › the plan: which group each board is drawn in, and what never moves a tile.
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { Cockpit } from '../src/app/cockpit/Cockpit'
import { renderScenario } from './render'
import { connected, model, newBoard, offline, panel, pdu, reported } from './scenarios'

const ZONE = ' — power zone details'

/**
 * The plan as drawn, top to bottom in its Left → Instrument panel → Right order: each group's
 * header (`PDU_Left` or `No power zone`), then its tiles' labels indented, symbol included.
 */
function plan(): string[] {
  const stage = screen.getByText('Instrument panel').parentElement!
  const out: string[] = []
  for (const el of Array.from(stage.children)) {
    const title = el.getAttribute('title') ?? ''
    if (title.endsWith(ZONE)) out.push(title.slice(0, -ZONE.length))
    else if (el.textContent === 'No power zone') out.push('No power zone')
    else if (title.startsWith('#')) out.push(`  ${el.textContent}`)
  }
  return out
}

describe('T17 Cockpit plan (B64, B10, X2)', () => {
  it('one group per placed PDU on its console, then the console’s No power zone; a panel sits under its PDU even on another console', async () => {
    await renderScenario(<Cockpit />, {
      device: connected(),
      model: model([
        panel(1, 'Center_Armament', { pduId: 4 }),
        panel(2, 'Right_Navigation', { pduId: 4 }),
        pdu(3, 'PDU_Left', { console: 'Left' }),
        pdu(4, 'PDU_Right', { console: 'Right' }),
        pdu(5, 'PDU_Left_Aft', { console: 'Left' }),
        panel(10, 'Left_Fuel', { pduId: 3 }),
        panel(11, 'Left_Oxygen'),
        panel(12, 'Center_Clock'),
        panel(13, 'Right_Radar', { pduId: 3 })
      ])
    })
    expect(plan()).toEqual([
      'PDU_Left',
      '  Fuel',
      '  Radar',
      'PDU_Left_Aft',
      'No power zone',
      '  Oxygen',
      'No power zone',
      '  Clock',
      'PDU_Right',
      '  Armament',
      '  Navigation'
    ])
    // A console with more than one PDU says how many under its title.
    expect(screen.getByText('Left console')).toHaveTextContent('Left console2 PDUs')
    expect(screen.getByText('Right console')).toHaveTextContent(/^Right console$/)
  })

  it('a hidden PDU’s boards keep their link but are drawn under No power zone, and return when it reports (B10)', async () => {
    const fed = panel(2, 'Right_Navigation', { pduId: 4 })
    const { sky } = await renderScenario(<Cockpit />, {
      device: connected(),
      model: model([fed], [], {
        hidden: [4],
        hiddenNodes: [{ nodeId: 4, name: 'PDU_Right', console: 'Right' }]
      })
    })
    expect(plan()).toEqual(['No power zone', '  Navigation'])

    // PDU_Right reports again: main un-hides it, and the board is back under it.
    sky.emitScenario({ model: model([pdu(4, 'PDU_Right', { console: 'Right' }), fed]) })
    expect(plan()).toEqual(['PDU_Right', '  Navigation'])
  })

  it('new boards on the bus are never placed, and a zone on a PDU not added yet reads No power zone', async () => {
    await renderScenario(<Cockpit />, {
      device: connected(),
      model: model([
        panel(2, 'Right_Navigation', { pduId: 41 }),
        newBoard(9, 0, {
          identified: 'panel',
          registry: { name: 'Left_Oxygen', console: 'Left', pduId: null }
        }),
        newBoard(41, 0, { name: 'PDU_Right_Fwd', kind: 'pdu', identified: 'pdu', console: 'Right' })
      ])
    })
    expect(plan()).toEqual(['No power zone', '  Navigation'])
    expect(screen.queryByTitle(/^#9 /)).toBeNull()
    expect(screen.queryByTitle(/^PDU_Right_Fwd/)).toBeNull()
  })

  it('a state change never moves a tile: same groups, same order, only the symbols change', async () => {
    const boards = (over: Record<number, Parameters<typeof panel>[2]> = {}) =>
      model([
        pdu(4, 'PDU_Right', { console: 'Right' }),
        panel(2, 'Right_Navigation', { pduId: 4, ...over[2] }),
        panel(6, 'Right_Radar', { pduId: 4, ...over[6] }),
        panel(7, 'Right_Lights', { pduId: 4, ...over[7] })
      ])
    const { sky } = await renderScenario(<Cockpit />, { device: connected(), model: boards() })
    expect(plan()).toEqual(['PDU_Right', '  Navigation', '  Radar', '  Lights'])

    sky.emitScenario({
      model: boards({ 2: offline(), 6: { status: reported(6, { overheat: true }) } })
    })
    expect(plan()).toEqual(['PDU_Right', '  Navigation✕', '  Radar!', '  Lights'])
  })

  it('a tile is labelled with the name less its console prefix; the full name is its tooltip', async () => {
    await renderScenario(<Cockpit />, {
      device: connected(),
      model: model([panel(14, 'Center_Armament_Station_Select_Long')])
    })
    // contract says a long name ends in "…" past about two columns; today the DOM label is the
    // whole short name and the "…" is drawn by CSS (text-overflow), so the text is pinned here.
    expect(plan()).toEqual(['No power zone', '  Armament_Station_Select_Long'])
    expect(screen.getByTitle('#14 Center_Armament_Station_Select_Long')).toBeInTheDocument()
  })
})
