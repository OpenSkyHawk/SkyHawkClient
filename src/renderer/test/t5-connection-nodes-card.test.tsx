// T5 — Connection › Connected nodes: the summary card.
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { Connection } from '../src/app/connection/Connection'
import { Cockpit } from '../src/app/cockpit/Cockpit'
import { App } from '../src/app/App'
import { renderScenario } from './render'
import {
  connected,
  link,
  model,
  newBoard,
  noStatusYet,
  nodeStatus,
  notSeen,
  offline,
  outage,
  panel,
  pdu
} from './scenarios'

// Local times: the card prints them in the computer's time zone.
const OFF_AT = new Date(2026, 9, 16, 21, 11, 18).getTime()
const LAST_SEEN = new Date(2026, 9, 14, 21, 14).getTime()

/**
 * PDU_Right (#4) went down with Right_Navigation (#2); Center_Armament (#1) is remembered but not
 * seen this session; Left_Oxygen (#7) overheats, fed by a PDU on the bus that isn't added yet
 * (#6); Left_Trim (#8) is error-passive; Center_Clock (#9) has no status yet; PDU_Left is fine.
 */
const scene = () =>
  model(
    [
      panel(1, 'Center_Armament', notSeen(LAST_SEEN)),
      panel(2, 'Right_Navigation', { pduId: 4, ...offline(OFF_AT) }),
      pdu(3, 'PDU_Left'),
      pdu(4, 'PDU_Right', offline(OFF_AT)),
      newBoard(6, OFF_AT, { kind: 'pdu', identified: 'pdu' }),
      panel(7, 'Left_Oxygen', { pduId: 6, status: nodeStatus(7, { nodeKind: 1, overheat: true }) }),
      panel(8, 'Left_Trim', { pduId: 3, status: nodeStatus(8, { nodeKind: 1, epvf: true }) }),
      panel(9, 'Center_Clock', noStatusYet())
    ],
    [outage(4, [2], 1)]
  )

/** A count in the card's header row: the number next to its label. */
const count = (label: string) => screen.getByText(label).parentElement?.textContent

/** The rows' "›" buttons, in order. */
const rowButtons = () =>
  screen
    .queryAllByRole('button', { name: /^Open .* in Cockpit$/ })
    .map((b) => b.getAttribute('aria-label'))

describe('T5 Connection › nodes summary card (B63, B14, B37, X2)', () => {
  it('counts your cockpit’s boards the way the Cockpit band does', async () => {
    const { unmount } = await renderScenario(<Connection />, {
      device: connected(),
      model: scene()
    })
    expect(count('healthy')).toBe('1healthy')
    expect(count('warning')).toBe('2warning')
    expect(count('offline')).toBe('3offline')
    expect(screen.getByText('PDUs · — W').parentElement).toHaveTextContent('2PDUs · — W')
    unmount()
    // The Cockpit band for the same model: 3 online = 1 healthy + 2 warning, 3 offline.
    await renderScenario(<Cockpit />, { device: connected(), model: scene() })
    expect(screen.getByText('Nodes online').parentElement).toHaveTextContent(
      '2 warning · 3 offline · 1 no status yet'
    )
    expect(screen.getByText('/ 7').parentElement).toHaveTextContent('3/ 7')
  })

  it('lists the 3 most severe boards in Attention order, with symbol, meta and chip', async () => {
    await renderScenario(<Connection />, { device: connected(), model: scene() })
    expect(rowButtons()).toEqual([
      'Open PDU_Right in Cockpit',
      'Open Center_Armament in Cockpit',
      'Open Left_Oxygen in Cockpit'
    ])
    const row = (meta: string) => screen.getByText(meta).parentElement
    expect(row('#4 · 1 node affected · offline since 21:11:18')).toHaveTextContent(
      '✕PDU_Right#4 · 1 node affected · offline since 21:11:18OFFLINE'
    )
    expect(
      row('#1 · no power zone · not seen this session · last seen 14 Oct, 21:14')
    ).toHaveTextContent(
      '✕Center_Armament#1 · no power zone · not seen this session · last seen 14 Oct, 21:14OFFLINE'
    )
    // contract X2: the plan puts #7 in No power zone (its PDU isn't in your cockpit); today the
    // card's meta names that PDU anyway, because it is on the bus.
    expect(row('#7 · Node 6')).toHaveTextContent('!Left_Oxygen#7 · Node 6OVERHEAT')
  })

  it('the footer counts the rest: "+N more · N no status yet · healthy nodes hidden"', async () => {
    await renderScenario(<Connection />, { device: connected(), model: scene() })
    expect(screen.getByText('+1 more · 1 no status yet · healthy nodes hidden')).toBeInTheDocument()
  })

  it('Refresh asks main for the roster while the link is up', async () => {
    const { sky, user } = await renderScenario(<Connection />, {
      device: connected(),
      model: scene()
    })
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(sky.refreshNodes).toHaveBeenCalledTimes(1)
  })

  it('Refresh is disabled and the rows give way to a hint while the link is down', async () => {
    await renderScenario(<Connection />, {
      device: link('disconnected'),
      model: scene()
    })
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled()
    expect(
      screen.getByText('Device link released — press Connect to see node status.')
    ).toBeInTheDocument()
    expect(rowButtons()).toEqual([])
  })

  it('"›" opens the Cockpit on that board', async () => {
    const { user } = await renderScenario(<App />, { device: connected(), model: scene() })
    await user.click(screen.getByRole('tab', { name: 'Connection' }))
    await user.click(screen.getByRole('button', { name: 'Open Center_Armament in Cockpit' }))
    expect(screen.getByRole('tab', { name: 'Cockpit' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('dialog', { name: 'Panel group Center_Armament' })).toBeInTheDocument()
  })
})
