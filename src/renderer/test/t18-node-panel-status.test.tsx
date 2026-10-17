// T18 — the panel group's side panel, Status tab: the fault boxes and "Reported by the node".
import { describe, expect, it, vi } from 'vitest'
import { act, screen, within } from '@testing-library/react'
import type { NodeModelEntry } from '@shared/nodes'
import { Cockpit } from '../src/app/cockpit/Cockpit'
import { renderScenario } from './render'
import {
  connected,
  model,
  newBoard,
  noStatusYet,
  notSeen,
  offline,
  panel,
  reported
} from './scenarios'

const T0 = new Date(2026, 9, 16, 21, 30, 0).getTime()
const LAST_SEEN = new Date(2026, 9, 14, 21, 14).getTime()

/** The Cockpit with Right_Navigation (#2) on it, as `over` says, and its panel open. */
async function openStatus(over: Partial<NodeModelEntry>, others: NodeModelEntry[] = []) {
  const r = await renderScenario(<Cockpit />, {
    device: connected(),
    model: model([panel(2, 'Right_Navigation', over), ...others])
  })
  await r.user.click(screen.getByTitle(/^#2 Right_Navigation/))
  const sheet = screen.getByRole('dialog', { name: 'Panel group Right_Navigation' })
  expect(within(sheet).getByRole('tab', { name: 'Status' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  return { ...r, sheet }
}

/** The fault boxes at the top of the tab, in order: `Title — text`. */
const boxes = (sheet: HTMLElement) =>
  Array.from(sheet.querySelectorAll('b'))
    .filter((b) => b.parentElement!.textContent!.startsWith(`${b.textContent} — `))
    .map((b) => b.parentElement!.textContent)

/** "Reported by the node": each row's label and value. */
const rows = (sheet: HTMLElement) =>
  ['Status', 'Uptime', 'CAN frames rx', 'CAN TEC / REC', 'CAN state', 'MCU temp'].map(
    (k) => within(sheet).getByText(k, { ignore: 'button' }).parentElement!.textContent
  )

const reportedBy = (sheet: HTMLElement) => within(sheet).getByText('Reported by the node')

describe('T18 Node panel, Status tab (B70, B14, F11)', () => {
  it('a healthy board: no box, and what it reports now', async () => {
    const { sheet } = await openStatus({})
    expect(boxes(sheet)).toEqual([])
    expect(rows(sheet)).toEqual([
      'Statushealthy',
      'Uptime00:01:40',
      'CAN frames rx10',
      'CAN TEC / REC0 / 0',
      'CAN stateerror-active',
      'MCU temp30 °C'
    ])
  })

  it('offline: one red box whatever it last raised, and only the last rx count is kept', async () => {
    const { sheet } = await openStatus({
      ...offline(),
      status: reported(2, { overheat: true, degraded: true, faultId: 1 })
    })
    expect(boxes(sheet)).toEqual([
      'Offline — missing from the Gateway roster — no heartbeat within its timeout.'
    ])
    expect(rows(sheet)).toEqual([
      'Statusoffline',
      'Uptime—',
      'CAN frames rx10 (last seen)',
      'CAN TEC / REC—',
      'CAN state—',
      'MCU temp—'
    ])
  })

  it('remembered but not seen this session: its own box with the last-seen time (B14)', async () => {
    const { sheet } = await openStatus(notSeen(LAST_SEEN))
    expect(screen.getByTitle('#2 Right_Navigation — NOT SEEN THIS SESSION')).toBeInTheDocument()
    expect(boxes(sheet)).toEqual([
      'Not seen this session — last seen 14 Oct, 21:14. It’s remembered from an earlier session. Forget or Hide it if it’s no longer part of your cockpit.'
    ])
    expect(rows(sheet)[2]).toBe('CAN frames rx—')
  })

  it('no complete roster yet and it hasn’t reported: "No status yet"', async () => {
    const { sheet } = await openStatus(noStatusYet())
    expect(boxes(sheet)).toEqual([
      'No status yet — no complete roster has arrived since the link opened, and this node has not reported.'
    ])
    expect(rows(sheet)[0]).toBe('Statusno status yet')
  })

  it('degraded: the fault table’s label and description; an unknown code reads "Fault N"', async () => {
    const known = await openStatus({ status: reported(2, { degraded: true, faultId: 1 }) })
    expect(boxes(known.sheet)).toEqual([
      'I2C peripheral — an I2C device (OLED/mux/expander) tripped its I2cHealth breaker'
    ])
    expect(rows(known.sheet)[0]).toBe('Statusdegraded')
    known.unmount()

    const unknown = await openStatus({ status: reported(2, { degraded: true, faultId: 200 }) })
    expect(boxes(unknown.sheet)).toEqual([
      'Fault 200 — reported by the node; this client has no description for this code.'
    ])
  })

  it('several faults stack in order: bus-off, fault, overheat, error-passive', async () => {
    const { sheet } = await openStatus({
      status: reported(2, {
        boff: true,
        degraded: true,
        faultId: 1,
        overheat: true,
        epvf: true,
        tec: 255,
        rec: 12
      })
    })
    expect(boxes(sheet)).toEqual([
      'Bus-off — its CAN controller stopped transmitting after too many errors. Reported by the node.',
      'I2C peripheral — an I2C device (OLED/mux/expander) tripped its I2cHealth breaker',
      'Overheat — the node raised its own temperature trip.',
      'Error-passive — its CAN error counters are high; it still communicates but can only signal errors passively.'
    ])
    expect(rows(sheet)).toEqual([
      'Statusbus-off',
      'Uptime00:01:40',
      'CAN frames rx10',
      'CAN TEC / REC255 / 12',
      'CAN statebus-off',
      'MCU temp30 °C'
    ])
  })

  it('a zone naming a board not in your cockpit is No power zone: Powered by opens nothing (D7)', async () => {
    // contract C6/X5 (the "Not in registry" label) is pinned in main (phase0-probes C6). A new
    // board's panel was reached only through a placed board's Powered by (X2 R3); with D7 (#131) a
    // zone is only ever a PDU in your cockpit, so Powered by reads the resolved zone: none here.
    const { sheet } = await openStatus({ pduId: 41 }, [
      newBoard(41, T0, {
        name: 'PDU_Right_Fwd',
        kind: 'pdu',
        identified: 'pdu',
        status: reported(41, { nodeKind: 2 }),
        registry: { name: 'PDU_Right_Fwd', console: 'Right', pduId: null }
      })
    ])
    expect(within(sheet).queryByRole('button', { name: 'Open PDU_Right_Fwd' })).toBeNull()
    expect(
      within(sheet).getByText('No power zone. Pick one in the Settings tab.')
    ).toBeInTheDocument()
  })

  it('fed by a hidden PDU: Powered by names it "(hidden)" and keeps the link (D7)', async () => {
    const r = await renderScenario(<Cockpit />, {
      device: connected(),
      model: model([panel(2, 'Right_Navigation', { pduId: 4 })], [], {
        hidden: [4],
        hiddenNodes: [
          { nodeId: 4, name: 'PDU_Right', console: 'Right', kind: 'pdu', source: 'registry' }
        ]
      })
    })
    await r.user.click(screen.getByTitle(/^#2 Right_Navigation/))
    const sheet = screen.getByRole('dialog', { name: 'Panel group Right_Navigation' })
    expect(within(sheet).getByText('Right console · PDU_Right (hidden)')).toBeInTheDocument()
    expect(
      within(sheet).getByText(
        'PDU_Right (hidden) — hidden until it reports again; this board keeps the link.'
      )
    ).toBeInTheDocument()
    expect(within(sheet).queryByRole('button', { name: /^Open PDU_Right/ })).toBeNull()
  })

  it('"updated N s ago" ticks while it reports; offline it reads "last report"', async () => {
    vi.useFakeTimers({ now: T0 })
    const { sheet, sky } = await openStatus({ reportedAt: T0 - 3000 })
    expect(reportedBy(sheet)).toHaveTextContent('Reported by the node· updated 3 s ago')
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(reportedBy(sheet)).toHaveTextContent('Reported by the node· updated 5 s ago')
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(reportedBy(sheet)).toHaveTextContent('Reported by the node· updated 1 min ago')

    sky.emitScenario({
      model: model([panel(2, 'Right_Navigation', { ...offline(), reportedAt: T0 - 3000 })])
    })
    expect(reportedBy(sheet)).toHaveTextContent('Reported by the node· last report 1 min ago')
  })

  it('with the link down the age reads "last known", and nothing ticks', async () => {
    vi.useFakeTimers({ now: T0 })
    const { sheet, sky } = await openStatus({ reportedAt: T0 - 3000 })
    sky.emitScenario({ device: { state: 'reconnecting' } })
    expect(reportedBy(sheet)).toHaveTextContent('Reported by the node· last known')
    expect(within(sheet).getByText(/Right console · no power zone/)).toHaveTextContent(
      'Right console · no power zone · last known'
    )
  })
})
