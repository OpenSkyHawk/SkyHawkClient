// T38 — a window reload (dev, or a renderer crash) while main keeps running: what main still holds
// for the screen comes back with the new page (N1) — the recording, the loaded capture, the serial
// monitor, the aircraft, the gauges, the session's peak W and the link's last-known time. Purely
// visual view state (the tab, an open dialog) still starts over.
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { Connection } from '../src/app/connection/Connection'
import { Cockpit } from '../src/app/cockpit/Cockpit'
import { Overview } from '../src/app/overview/Overview'
import { Serial } from '../src/gateway/Serial'
import { App } from '../src/app/App'
import { reloadRenderer, renderScenario, settle } from './render'
import { connected, model, pdu, pduTelemetry, simTelemetry } from './scenarios'

/** A hero tile's value line, by its label. */
const tileValue = (label: string) => screen.getByText(label).parentElement!.children[1]!
/** A gauge's readout, by its label. */
const gauge = (label: string) =>
  screen.getByText(label).parentElement!.querySelector('.gauge__center')!.textContent
/** A Cockpit band card's whole text, by its label. */
const card = (label: string) => screen.getByText(label).parentElement!.textContent

describe('T38 a reload keeps what main holds (N1)', () => {
  it('the recording that is running', async () => {
    const page = await renderScenario(<Connection />, {
      device: connected(),
      relay: { running: true, stream: 'connected' }
    })
    page.sky.toggleCapture.mockResolvedValueOnce({ recording: true, events: 42 })
    await page.user.click(screen.getByRole('button', { name: 'Start recording…' }))
    await settle()
    expect(screen.getByRole('button', { name: 'Stop recording · 42 events' })).toBeEnabled()

    await reloadRenderer(<Connection />, page)
    expect(screen.getByRole('button', { name: 'Stop recording · 42 events' })).toBeEnabled()
  })

  it('the capture loaded for Replay', async () => {
    const page = await renderScenario(<Connection />, {
      device: connected(),
      config: { sourceMode: 'replay' }
    })
    page.sky.openReplay.mockResolvedValueOnce({
      loaded: true,
      path: '/Users/me/captures/carrier-trap.skycap',
      events: 1200,
      durationMs: 45_300
    })
    await page.user.click(screen.getByRole('button', { name: 'Load capture…' }))
    await settle()
    const loaded = 'carrier-trap.skycap · 1200 events · 45.3s — press Start to play.'
    expect(screen.getByText('carrier-trap.skycap').parentElement).toHaveTextContent(loaded)

    await reloadRenderer(<Connection />, page)
    expect(screen.getByText('carrier-trap.skycap').parentElement).toHaveTextContent(loaded)
  })

  it('the serial monitor, still running', async () => {
    const page = await renderScenario(<Serial />, { device: connected() })
    await page.user.click(screen.getByRole('button', { name: 'Start monitor' }))
    expect(screen.getByText('MONITORING')).toBeInTheDocument()

    await reloadRenderer(<Serial />, page)
    expect(screen.getByText('MONITORING')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '● Monitoring' })).toBeInTheDocument()
  })

  it('the aircraft and the gauges, after the relay stopped', async () => {
    const page = await renderScenario(<Overview />, {
      device: connected(),
      relay: { running: true, stream: 'connected' },
      aircraft: { name: 'A-4E-C', inferred: false, supported: true },
      gauges: simTelemetry({ RPM: 0.85, D_FUEL: 0.6 })
    })
    page.sky.emitScenario({ relay: { running: false } })
    expect(tileValue('Aircraft')).toHaveTextContent('A-4E-C')
    expect([gauge('RPM'), gauge('Fuel')]).toEqual(['85% RPM', '60% QTY'])

    await reloadRenderer(<Overview />, page)
    expect(tileValue('Aircraft')).toHaveTextContent('A-4E-C')
    expect([gauge('RPM'), gauge('Fuel')]).toEqual(['85% RPM', '60% QTY'])
  })

  it('the session’s peak W and, with the link down, the last-known time', async () => {
    const page = await renderScenario(<Cockpit />, {
      device: connected(),
      model: model([
        pdu(3, 'PDU_Left', { console: 'Left', readings: 'live', everHadReadings: true })
      ]),
      telemetry: [pduTelemetry(3, { rail12V: { iAvgMa: 2000 } })]
    })
    page.sky.emitScenario({ telemetry: [pduTelemetry(3, { rail12V: { iAvgMa: 500 } })] })
    expect(card('Total power')).toBe('Total power6.0 W / 650peak 24.0 W')
    page.sky.emitScenario({ device: { state: 'no-device' } })
    const lastKnown = card('Nodes online')
    expect(lastKnown).toMatch(/^Nodes onlinelast known · \d\d:\d\d$/)

    await reloadRenderer(<Cockpit />, page)
    expect(card('Total power')).toMatch(/peak 24\.0 W$/)
    expect(card('Nodes online')).toBe(lastKnown)
  })

  it('the tab the page showed still starts over (view state)', async () => {
    const page = await renderScenario(<App />, { device: connected() })
    await page.user.click(screen.getByRole('tab', { name: 'Serial' }))
    expect(screen.getByRole('tab', { name: 'Serial' })).toHaveAttribute('aria-selected', 'true')

    await reloadRenderer(<App />, page)
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
  })
})
