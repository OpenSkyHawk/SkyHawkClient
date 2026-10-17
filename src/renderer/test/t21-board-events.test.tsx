// T21 — Cockpit › Board events: the session's node events, and the way into Log › Events.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import { App } from '../src/App'
import { Cockpit } from '../src/tabs/Cockpit'
import { renderScenario } from './render'
import { connected, logEvent, model, panel } from './scenarios'

/** The Board events card. */
const card = () => screen.getByText('Board events').parentElement!.parentElement!
const lines = () =>
  within(card())
    .queryAllByRole('listitem')
    .map((li) => li.textContent)

/** Node events about two boards, a roster summary and a client event, oldest first. */
const session = () => [
  logEvent(2, {
    nodeId: 2,
    name: 'Right_Navigation',
    severity: 'info',
    event: 'online',
    detail: undefined
  }),
  logEvent(3, {
    source: 'client',
    nodeId: undefined,
    name: 'SERIAL',
    severity: 'info',
    event: 'connected',
    detail: '/dev/cu.usbmodem1'
  }),
  logEvent(4, {
    nodeId: undefined,
    name: 'Roster',
    severity: 'info',
    event: 'roster complete',
    detail: '2 nodes'
  }),
  logEvent(5)
]

describe('T21 BoardEvents (B75)', () => {
  it('says so when the session has no board events yet', async () => {
    await renderScenario(<Cockpit />, { device: connected(), model: model([]) })
    expect(within(card()).getByText('No board events yet this session.')).toBeInTheDocument()
    expect(within(card()).getByText('0 events this session')).toBeInTheDocument()
  })

  it('node rows only, newest first, one line each, with the count', async () => {
    const { sky } = await renderScenario(<Cockpit />, {
      device: connected(),
      model: model([panel(1, 'Center_Armament')]),
      events: [
        logEvent(1, {
          source: 'client',
          nodeId: undefined,
          name: 'DCS',
          severity: 'info',
          event: 'export stream up'
        })
      ]
    })
    // A client event is not a board event.
    expect(within(card()).getByText('No board events yet this session.')).toBeInTheDocument()

    sky.emitScenario({ events: session() })
    expect(lines()).toEqual([
      '12:00:05Center_Armament offline · no heartbeat',
      '12:00:04roster complete · 2 nodes',
      '12:00:02Right_Navigation online'
    ])
    expect(within(card()).getByText('3 events this session')).toBeInTheDocument()
    expect(within(card()).getByTitle('Center_Armament offline · no heartbeat')).toBeInTheDocument()

    sky.emitScenario({ events: [logEvent(6, { nodeId: 2, name: 'Right_Navigation' })] })
    expect(lines()[0]).toBe('12:00:06Right_Navigation offline · no heartbeat')
    expect(within(card()).getByText('4 events this session')).toBeInTheDocument()
  })

  it('"View all in Log →" opens Log › Events, filtered to Nodes', async () => {
    const { user } = await renderScenario(<App />, {
      device: connected(),
      model: model([panel(1, 'Center_Armament')]),
      events: session()
    })
    await user.click(screen.getByRole('tab', { name: 'Cockpit' }))
    await user.click(within(card()).getByRole('button', { name: 'View all in Log →' }))

    expect(screen.getByRole('tab', { name: 'Log' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Events 4' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByText('Client · SERIAL')).toBeNull()
    expect(screen.getByText('Center_Armament')).toBeInTheDocument()
    expect(
      screen.getByText('3 of 4 events this session · in memory, cleared on restart')
    ).toBeInTheDocument()

    // Nodes was the filter: All brings the client row back.
    await user.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByText('Client · SERIAL')).toBeInTheDocument()
  })
})
