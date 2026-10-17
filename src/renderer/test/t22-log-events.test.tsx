// T22 — Log › Events: the session's event log, its filters, Pause, Clear and Export.
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { Log } from '../src/app/log/Log'
import { renderScenario } from './render'
import { connected, logEvent } from './scenarios'

/** Five events, oldest first: node offline, client connected, PDU flag, new board, relay refused. */
const session = () => [
  logEvent(1),
  logEvent(2, {
    source: 'client',
    nodeId: undefined,
    name: 'SERIAL',
    severity: 'info',
    event: 'connected',
    detail: '/dev/cu.usbmodem1',
    raw: 'serial: opened /dev/cu.usbmodem1'
  }),
  logEvent(3, {
    nodeId: 4,
    name: 'PDU_Right',
    severity: 'warn',
    event: '5V UNDER-V raised',
    detail: '4.71 V',
    raw: '_NODE_TELEM 040201661226120000'
  }),
  logEvent(4, {
    nodeId: 9,
    name: 'Left_Oxygen',
    severity: 'new',
    event: 'new on the bus',
    detail: 'from NODE_IDS.md'
  }),
  logEvent(5, {
    source: 'client',
    nodeId: undefined,
    name: 'Relay',
    severity: 'error',
    event: 'start refused',
    detail: 'no board',
    raw: 'relay: start refused (bridge mode needs a board)'
  })
]

/** The listed rows, top to bottom: time, severity glyph, source, message. */
const rows = () =>
  screen
    .queryAllByLabelText(/^(Offline \/ error|Warning|New|Cleared \/ info)$/)
    .map((glyph) => glyph.parentElement!.textContent)

const footer = (text: string) => screen.getByText(text)

async function openEvents() {
  const r = await renderScenario(<Log />, { device: connected(), events: session() })
  await r.user.click(screen.getByRole('tab', { name: 'Events 5' }))
  expect(screen.getByRole('tab', { name: 'Events 5' })).toHaveAttribute('aria-selected', 'true')
  const button = (name: string) => screen.getByRole('button', { name })
  return { ...r, button }
}

describe('T22 Log › Events (B78, B55)', () => {
  it('lists the session newest first; the source filter picks Nodes or Client', async () => {
    const { user, button } = await openEvents()
    expect(rows()).toEqual([
      '12:00:05.000✕Client · Relaystart refused · no board',
      '12:00:04.000+Left_Oxygennew on the bus · from NODE_IDS.md',
      '12:00:03.000!PDU_Right5V UNDER-V raised · 4.71 V',
      '12:00:02.000●Client · SERIALconnected · /dev/cu.usbmodem1',
      '12:00:01.000✕Center_Armamentoffline · no heartbeat'
    ])
    expect(footer('5 events this session · in memory, cleared on restart')).toBeInTheDocument()

    await user.click(button('Nodes'))
    expect(rows()).toEqual([
      '12:00:04.000+Left_Oxygennew on the bus · from NODE_IDS.md',
      '12:00:03.000!PDU_Right5V UNDER-V raised · 4.71 V',
      '12:00:01.000✕Center_Armamentoffline · no heartbeat'
    ])
    expect(footer('3 of 5 events this session · in memory, cleared on restart')).toBeInTheDocument()

    await user.click(button('Client'))
    expect(rows()).toEqual([
      '12:00:05.000✕Client · Relaystart refused · no board',
      '12:00:02.000●Client · SERIALconnected · /dev/cu.usbmodem1'
    ])
  })

  it('"Problems only" keeps the ✕ and ! rows', async () => {
    const { user, button } = await openEvents()
    await user.click(button('Problems only'))
    expect(button('Problems only')).toHaveAttribute('aria-pressed', 'true')
    expect(rows().map((r) => r!.slice(12, 13))).toEqual(['✕', '!', '✕'])
  })

  it('search matches the source label and the event text, case-insensitive', async () => {
    const { user } = await openEvents()
    const search = screen.getByPlaceholderText('Search source or event…')
    await user.type(search, 'pdu_right')
    expect(rows()).toEqual(['12:00:03.000!PDU_Right5V UNDER-V raised · 4.71 V'])
    await user.clear(search)
    await user.type(search, 'client · serial')
    expect(rows()).toEqual(['12:00:02.000●Client · SERIALconnected · /dev/cu.usbmodem1'])
    await user.clear(search)
    await user.type(search, 'NO BOARD')
    expect(rows()).toEqual(['12:00:05.000✕Client · Relaystart refused · no board'])
    expect(footer('1 of 5 events this session · in memory, cleared on restart')).toBeInTheDocument()
  })

  it('Raw shows each row’s source line, under "Message (raw)"', async () => {
    const { user, button } = await openEvents()
    expect(screen.getByText('Event')).toBeInTheDocument()
    await user.click(button('Decoded'))
    expect(button('Raw')).toBeInTheDocument()
    expect(screen.getByText('Message (raw)')).toBeInTheDocument()
    expect(screen.queryByText('Event')).toBeNull()
    expect(rows()[0]).toBe(
      '12:00:05.000✕Client · Relayrelay: start refused (bridge mode needs a board)'
    )
  })

  it('Pause holds the list (PAUSED) while the tab count rises; Resume shows what arrived', async () => {
    const { user, sky, button } = await openEvents()
    expect(footer('LIVE')).toBeInTheDocument()
    await user.click(button('❚❚ Pause'))
    expect(footer('PAUSED')).toBeInTheDocument()

    sky.emitScenario({
      events: [...session(), logEvent(6, { nodeId: 2, name: 'Right_Navigation' })]
    })
    expect(screen.getByRole('tab', { name: 'Events 6' })).toBeInTheDocument()
    expect(rows()).toHaveLength(5)
    expect(screen.queryByText('Right_Navigation')).toBeNull()

    await user.click(button('▶ Resume'))
    expect(footer('LIVE')).toBeInTheDocument()
    expect(rows()[0]).toBe('12:00:06.000✕Right_Navigationoffline · no heartbeat')
  })

  it('Clear empties the list and asks main to clear its copy', async () => {
    const { user, sky, button } = await openEvents()
    await user.click(button('Clear'))
    expect(sky.clearEvents).toHaveBeenCalledTimes(1)
    expect(rows()).toEqual([])
    expect(screen.getByRole('tab', { name: 'Events 0' })).toBeInTheDocument()
  })

  it('Export saves through main and the footer says where and how many rows', async () => {
    const { user, sky, button } = await openEvents()
    sky.exportEvents.mockResolvedValueOnce({ path: '/Users/me/Documents/skyhawk-events-5.tsv' })
    await user.click(button('Export'))
    expect(sky.exportEvents).toHaveBeenCalledTimes(1)
    // contract B78: main suggests `skyhawk-events-<n>.tsv` in its save dialog (not visible here).
    expect(await screen.findByText('✓ Saved skyhawk-events-5.tsv · 5 rows')).toBeInTheDocument()
  })

  it('Export with no events asks main for nothing', async () => {
    const { user, sky, button } = await openEvents()
    await user.click(button('Clear'))
    await user.click(button('Export'))
    expect(sky.exportEvents).not.toHaveBeenCalled()
  })
})
