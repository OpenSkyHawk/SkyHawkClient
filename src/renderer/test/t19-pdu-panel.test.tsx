// T19 — the PDU's side panel: its fault boxes, rails, board status and the boards it feeds.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import type { NodeModelEntry, NodeTelemSnapshot, PduOutage } from '@shared/nodes'
import { PDU_RAIL_FLAGS, PDU_STATUS_FLAGS } from '@shared/firmware'
import { Cockpit } from '../src/app/cockpit/Cockpit'
import { renderScenario } from './render'
import { connected, model, offline, outage, panel, pdu, pduTelemetry } from './scenarios'

/**
 * PDU_Right (#4, Right console, as `over` says) feeding Right_Navigation (#2) and Right_Radar
 * (#6, as `radar` says); the PDU's panel open.
 */
async function openPdu(
  over: Partial<NodeModelEntry>,
  telemetry: NodeTelemSnapshot[] = [],
  outages: PduOutage[] = [],
  radar: Partial<NodeModelEntry> = {}
) {
  const r = await renderScenario(<Cockpit />, {
    device: connected(),
    model: model(
      [
        panel(2, 'Right_Navigation', { pduId: 4 }),
        pdu(4, 'PDU_Right', { console: 'Right', ...over }),
        panel(6, 'Right_Radar', { pduId: 4, ...radar })
      ],
      outages
    ),
    telemetry
  })
  await r.user.click(screen.getByTitle('PDU_Right — power zone details'))
  const sheet = screen.getByRole('dialog', { name: 'PDU PDU_Right' })
  return { ...r, sheet }
}

/** The fault boxes at the top of the Status tab, in order: `Title — text`. */
const boxes = (sheet: HTMLElement) =>
  Array.from(sheet.querySelectorAll('b'))
    .filter((b) => b.parentElement!.textContent!.startsWith(`${b.textContent} — `))
    .map((b) => b.parentElement!.textContent)

/** A labelled row's whole text: a rail (`12 V`) or a Board status row. */
const row = (sheet: HTMLElement, k: string) =>
  within(sheet).getByText(k, { ignore: 'button' }).parentElement!.textContent

const live = { readings: 'live' as const, everHadReadings: true }

describe('T19 PDU panel (B71)', () => {
  it('offline: one box, with the blown-fuse sentence only when its boards dropped with it', async () => {
    const out = await openPdu(offline(), [], [outage(4, [2, 6], 2)], offline())
    expect(boxes(out.sheet)).toEqual([
      'Offline — no status or readings from this PDU. Its nodes dropped at the same time — a blown 5 V fuse at the PDU looks like this.'
    ])
    out.unmount()

    const alone = await openPdu(offline())
    expect(boxes(alone.sheet)).toEqual(['Offline — no status or readings from this PDU.'])
    expect(row(alone.sheet, '12 V')).toBe('12 Vavg — Vmin — V— Apeak — A')
  })

  it('online without readings: "No readings received", with the firmware hint only if it never had any', async () => {
    const never = await openPdu({ readings: 'none', everHadReadings: false })
    expect(boxes(never.sheet)).toEqual([
      'No readings received — the PDU is online but no telemetry has arrived. If it never had readings, the Gateway firmware may be too old to forward PDU telemetry.'
    ])
    expect(row(never.sheet, 'Connector temp (NTC)')).toBe('Connector temp (NTC)—')
    never.unmount()

    const lapsed = await openPdu({ readings: 'none', everHadReadings: true })
    expect(boxes(lapsed.sheet)).toEqual([
      'No readings received — the PDU is online but no telemetry has arrived.'
    ])
  })

  it('raised flags are one box carrying their meanings; UNCAL is only a calibration row', async () => {
    const { sheet } = await openPdu(live, [
      pduTelemetry(4, {
        rail12V: { flags: PDU_RAIL_FLAGS.OVER_CURRENT, iAvgMa: 9000 },
        rail5V: { flags: PDU_RAIL_FLAGS.UNDER_V, vAvgMv: 4710, vMinMv: 4650 },
        status: { flags: PDU_STATUS_FLAGS.TEMP_WARN | PDU_STATUS_FLAGS.UNCAL_VDDA, ntcTempC: 61 }
      })
    ])
    expect(boxes(sheet)).toEqual([
      '12V OVER-I · 5V UNDER-V · TEMP WARN — the 12 V rail is drawing sustained current above the over-current threshold; the 5 V rail is below its under-voltage threshold; board temperature at the warning threshold. Raised by the board.'
    ])
    expect(row(sheet, 'VDDA calibration')).toBe(
      'VDDA calibrationnot done — readings assume a nominal 3.3 V'
    )
    expect(row(sheet, 'Zero calibration')).toBe('Zero calibrationdone')
    expect(row(sheet, 'Connector temp (NTC)')).toBe('Connector temp (NTC)61.0 °C')
  })

  it('rails: avg / min / A / peak A per rail, a negative offset reads 0, and the W the client computes', async () => {
    const { sheet } = await openPdu(live, [
      pduTelemetry(4, {
        rail12V: { vAvgMv: 12_100, vMinMv: 11_950, iAvgMa: 2000 },
        rail5V: { vAvgMv: 5020, vMinMv: 4980, iAvgMa: -20 },
        status: { ntcTempC: 31.5, i12PeakMa: 2300, i5PeakMa: 400 }
      })
    ])
    expect(boxes(sheet)).toEqual([])
    expect(within(sheet).getByText('Rails · live')).toBeInTheDocument()
    expect(row(sheet, '12 V')).toBe('12 Vavg 12.10 Vmin 11.95 V2.00 Apeak 2.30 A')
    expect(row(sheet, '5 V')).toBe('5 Vavg 5.02 Vmin 4.98 V0.00 Apeak 0.40 A')
    expect(
      within(sheet).getByText(
        '3-second window per page. Power (W) is computed here: 24.2 W + 0.0 W.'
      )
    ).toBeInTheDocument()
    expect(row(sheet, 'Connector temp (NTC)')).toBe('Connector temp (NTC)31.5 °C')
    expect(row(sheet, 'MCU temp')).toBe('MCU temp30 °C')
    expect(row(sheet, 'VDDA calibration')).toBe('VDDA calibrationdone')
  })

  it('an NTC fault or an unavailable NTC reads as such', async () => {
    const fault = await openPdu(live, [
      pduTelemetry(4, { status: { flags: PDU_STATUS_FLAGS.NTC_FAULT, ntcTempC: null } })
    ])
    expect(row(fault.sheet, 'Connector temp (NTC)')).toBe(
      'Connector temp (NTC)fault — NTC open or shorted'
    )
    fault.unmount()

    const none = await openPdu(live, [pduTelemetry(4, { status: { ntcTempC: null } })])
    expect(row(none.sheet, 'Connector temp (NTC)')).toBe('Connector temp (NTC)unavailable')
  })

  it('"Feeds · N" lists the boards it powers, and opening one switches to its panel', async () => {
    const { sheet, user } = await openPdu({}, [], [], offline())
    await user.click(within(sheet).getByRole('tab', { name: 'Feeds · 2' }))
    const list = within(sheet).getByRole('list')
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual(['Right_Navigationonline · #2', '✕Right_RadarOFFLINE · #6'])
    await user.click(within(list).getByRole('button', { name: 'Open Right_Navigation' }))
    expect(screen.getByRole('dialog', { name: 'Panel group Right_Navigation' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'PDU PDU_Right' })).toBeNull()
  })
})
