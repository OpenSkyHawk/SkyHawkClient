// T20 — Cockpit › the health band over the plan, and the plan's search and Issues filter.
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { PDU_STATUS_FLAGS } from '@shared/firmware'
import { Cockpit } from '../src/app/cockpit/Cockpit'
import { renderScenario } from './render'
import {
  connected,
  model,
  newBoard,
  noStatusYet,
  offline,
  panel,
  pdu,
  pduTelemetry,
  reported
} from './scenarios'

/** A band card's whole text, from its label: label, value, limit and sub-line. */
const card = (label: string) => screen.getByText(label).parentElement!.textContent

const live = { readings: 'live' as const, everHadReadings: true }

/**
 * Two PDUs in your cockpit with fresh pages (PDU_Right's 5 V current a small negative offset,
 * its NTC at the warning threshold), five panel groups — healthy (TEC 5), offline, bus-off, no
 * status yet, overheating with REC 96 — a new PDU on the bus with readings of its own, and a
 * second Gateway on the bus (a stray).
 */
const scene = () => ({
  device: connected(),
  model: model([
    panel(1, 'Center_Armament', { status: reported(1, { tec: 5 }) }),
    panel(2, 'Right_Navigation', offline()),
    pdu(3, 'PDU_Left', { console: 'Left', ...live }),
    pdu(4, 'PDU_Right', { console: 'Right', ...live }),
    panel(6, 'Right_Radar', { status: reported(6, { boff: true }) }),
    panel(7, 'Left_Oxygen', noStatusYet()),
    panel(8, 'Left_Fuel', { status: reported(8, { overheat: true, tec: 30, rec: 96 }) }),
    newBoard(9, 0, { identified: 'bridge' }),
    newBoard(41, 0, { name: 'PDU_Right_Fwd', kind: 'pdu', identified: 'pdu', ...live })
  ]),
  telemetry: [
    pduTelemetry(3, {
      rail12V: { iAvgMa: 2000 },
      rail5V: { iAvgMa: 1000 },
      status: { ntcTempC: 35 }
    }),
    pduTelemetry(4, {
      rail12V: { iAvgMa: 1000 },
      rail5V: { vAvgMv: 4900, vMinMv: 4880, iAvgMa: -50 },
      status: { flags: PDU_STATUS_FLAGS.TEMP_WARN, ntcTempC: 48 }
    }),
    pduTelemetry(41, { rail12V: { iAvgMa: 5000 } })
  ]
})

/** A plan tile, by NODE_ID. */
const tile = (id: number) => screen.getByTitle(new RegExp(`^#${id} `))
/**
 * contract B69 asks for user-visible results; today a tile the search or the Issues filter
 * leaves out is only greyed by a CSS class (no text or ARIA state changes), so that class is the
 * one thing there is to pin.
 */
const lit = () => [1, 2, 6, 7, 8].filter((id) => !tile(id).classList.contains('tile2--dim'))

describe('T20 Cockpit health band + search/Issues (B67, B69)', () => {
  it('band: your cockpit’s boards plus strays; unknown counted apart; new boards left out', async () => {
    await renderScenario(<Cockpit />, scene())
    // 7 known + 1 stray; online = 2 healthy + 2 warning + the stray.
    expect(screen.getByText('/ 8').parentElement).toHaveTextContent('5/ 8')
    expect(card('Nodes online')).toBe('Nodes online3 warning · 2 offline · 1 no status yet')
  })

  it('band: amps and W over in-cockpit PDUs with fresh readings, lowest 5 V, worst CAN, hottest PDU', async () => {
    await renderScenario(<Cockpit />, scene())
    // 12 V: 2 A + 1 A (the new PDU's 5 A is not yours yet); 5 V: 1 A + a negative offset read as 0.
    expect(card('12 V bus')).toBe('12 V bus3.00 A / 5436.0 W · 2 PDUs')
    expect(card('5 V bus')).toBe('5 V bus1.00 A / 20low 4.90 V · #4')
    expect(card('Total power')).toBe('Total power41.0 W / 650peak 41.0 W')
    // The worst counters are #8's REC 96, but a bus-off board is named first.
    expect(card('CAN errors')).toBe('CAN errorsREC 96worst #6 · 1 bus-off')
    expect(card('Hottest PDU')).toBe('Hottest PDU48.0 °CPDU_Right · connectors')
  })

  it('band: the peak W holds for the session when the draw falls', async () => {
    const { sky } = await renderScenario(<Cockpit />, scene())
    sky.emitScenario({
      telemetry: [pduTelemetry(3, { rail12V: { iAvgMa: 500 } })]
    })
    expect(card('Total power')).toBe('Total power6.0 W / 650peak 41.0 W')
  })

  it('band: with the link down every reading is a dash, and the ring says last known', async () => {
    const { sky } = await renderScenario(<Cockpit />, scene())
    sky.emitScenario({ device: { state: 'no-device' } })
    expect(card('12 V bus')).toBe('12 V bus— / 54no live readings')
    expect(card('CAN errors')).toBe('CAN errors—no live readings')
    expect(card('Nodes online')).toMatch(/^Nodes onlinelast known · \d\d:\d\d$/)
  })

  it('search lights the tiles whose name or NODE_ID matches, case-insensitive', async () => {
    const { user } = await renderScenario(<Cockpit />, scene())
    const find = screen.getByRole('textbox', { name: 'Find panel by name or NODE_ID' })
    expect(lit()).toEqual([1, 2, 6, 7, 8])
    await user.type(find, 'right_')
    expect(lit()).toEqual([2, 6])
    await user.clear(find)
    await user.type(find, '#8')
    expect(lit()).toEqual([8])
    await user.clear(find)
    await user.type(find, '7')
    expect(lit()).toEqual([7])
  })

  it('Issues lights only the boards with an issue — not healthy, not unknown — and combines with search', async () => {
    const { user } = await renderScenario(<Cockpit />, scene())
    const issues = screen.getByRole('button', { name: 'Issues' })
    await user.click(issues)
    expect(issues).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false')
    expect(lit()).toEqual([2, 6, 8])
    await user.type(screen.getByRole('textbox', { name: 'Find panel by name or NODE_ID' }), 'left')
    expect(lit()).toEqual([8])
    await user.click(screen.getByRole('button', { name: 'All' }))
    expect(lit()).toEqual([7, 8])
  })
})
