// T2 — Cockpit › Attention: order, the Gateway item, "+N more", empty states.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import { Cockpit } from '../src/app/cockpit/Cockpit'
import { DevicePopover } from '../src/app/titlebar/DevicePopover'
import { renderScenario } from './render'
import {
  connected,
  gateway,
  link,
  model,
  nodeStatus,
  offline,
  outage,
  panel,
  pdu
} from './scenarios'

/** The Attention card's rows, in order (the only list on the Cockpit with no board events). */
const attentionRows = () => screen.queryAllByRole('listitem').map((li) => li.textContent)

/**
 * PDU_Right (#4) went down with the one board it feeds (#2); #1 is offline on its own; #3 and #6
 * raise warnings. Listed out of order, so the order on screen is the UI's own.
 */
const troubled = () =>
  model(
    [
      panel(6, 'Right_TACAN', { status: nodeStatus(6, { nodeKind: 1, epvf: true }) }),
      panel(3, 'Left_Oxygen', { status: nodeStatus(3, { nodeKind: 1, overheat: true }) }),
      panel(2, 'Right_Navigation', { pduId: 4, ...offline() }),
      panel(1, 'Center_Armament', offline()),
      pdu(4, 'PDU_Right', offline())
    ],
    [outage(4, [2], 1)]
  )

describe('T2 Cockpit › Attention: order and Gateway (B65, B42, B37)', () => {
  it('Gateway first, then the outage, offline and warnings by NODE_ID, capped with "+N more"', async () => {
    await renderScenario(<Cockpit />, {
      device: connected(gateway({ boff: true })),
      model: troubled()
    })
    // 4 board items + the Gateway; 3 rows shown, the Gateway's included.
    expect(screen.getByText('5 items')).toBeInTheDocument()
    expect(attentionRows()).toEqual([
      '✕GatewayBus-off',
      '✕PDU_RightOFFLINE · 1 node affected · #4',
      '✕Center_ArmamentOFFLINE · #1'
    ])
    expect(screen.getByText('+2 more')).toBeInTheDocument()
    // The board that dropped with its PDU is folded into the outage, and the plan explains it.
    expect(screen.queryByText(/Right_Navigation/)).toBeNull()
    expect(
      screen.getByText(
        'The only node on this PDU lost power with it — a blown 5 V fuse at the PDU looks like this.'
      )
    ).toBeInTheDocument()
  })

  it('without a Gateway problem the warnings follow, by NODE_ID', async () => {
    await renderScenario(<Cockpit />, { device: connected(), model: troubled() })
    expect(screen.getByText('4 items')).toBeInTheDocument()
    expect(attentionRows()).toEqual([
      '✕PDU_RightOFFLINE · 1 node affected · #4',
      '✕Center_ArmamentOFFLINE · #1',
      '!Left_OxygenOVERHEAT · #3'
    ])
    expect(screen.getByText('+1 more')).toBeInTheDocument()
  })

  it('a Gateway warning is a "!" item; a healthy Gateway is no item', async () => {
    const { sky } = await renderScenario(<Cockpit />, {
      device: connected(gateway({ epvf: true })),
      model: model([panel(1, 'Center_Armament')])
    })
    expect(attentionRows()).toEqual(['!GatewayError-passive'])
    sky.emitScenario({ device: connected(gateway()) })
    expect(screen.getByText('Nothing needs attention.')).toBeInTheDocument()
    expect(screen.getByText('0 items')).toBeInTheDocument()
  })

  it('the Gateway cog opens the Device popover', async () => {
    const { user } = await renderScenario(
      <>
        <DevicePopover />
        <Cockpit />
      </>,
      { device: connected(gateway({ boff: true })), model: troubled() }
    )
    expect(screen.queryByRole('dialog', { name: 'Device link' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Gateway details' }))
    const pop = screen.getByRole('dialog', { name: 'Device link' })
    expect(within(pop).getByText('Bus-off')).toBeInTheDocument()
  })

  it('an outage cog opens the PDU’s panel; a board cog opens the board’s', async () => {
    const { user } = await renderScenario(<Cockpit />, {
      device: connected(),
      model: troubled()
    })
    await user.click(screen.getByRole('button', { name: 'PDU_Right details' }))
    expect(screen.getByRole('dialog', { name: 'PDU PDU_Right' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.click(screen.getByRole('button', { name: 'Center_Armament details' }))
    expect(screen.getByRole('dialog', { name: 'Panel group Center_Armament' })).toBeInTheDocument()
  })

  it('"Show all on map" switches the plan to Issues', async () => {
    const { user } = await renderScenario(<Cockpit />, {
      device: connected(),
      model: troubled()
    })
    expect(screen.getByRole('button', { name: 'Issues' })).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: 'Show all on map' }))
    expect(screen.getByRole('button', { name: 'Issues' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('"Nothing needs attention." with every board healthy', async () => {
    await renderScenario(<Cockpit />, {
      device: connected(),
      model: model([panel(1, 'Center_Armament'), pdu(4, 'PDU_Right')])
    })
    expect(screen.getByText('Nothing needs attention.')).toBeInTheDocument()
    expect(attentionRows()).toEqual([])
  })

  it('"No live node status — connect the Gateway." while the link is down, problems or not', async () => {
    await renderScenario(<Cockpit />, {
      device: link('reconnecting', { gateway: gateway({ boff: true }) }),
      model: troubled()
    })
    expect(screen.getByText('No live node status — connect the Gateway.')).toBeInTheDocument()
    expect(attentionRows()).toEqual([])
    expect(screen.queryByText('+2 more')).toBeNull()
    // Nothing is counted either: the board items and the Gateway's own problem go with the link.
    expect(screen.getByText('0 items')).toBeInTheDocument()
  })
})
