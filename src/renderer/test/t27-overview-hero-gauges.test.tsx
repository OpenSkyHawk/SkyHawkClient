// T27 — Overview: the hero tiles (Link, Aircraft, DCS Link), the sim-telemetry gauges and the
// Stream Health cards.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import type { DeviceState } from '@shared/gateway'
import type { Scenario } from './skyhawk-mock'
import { Overview } from '../src/app/overview/Overview'
import { App } from '../src/app/App'
import { renderScenario } from './render'
import { connected, link, simTelemetry, streamStats } from './scenarios'

/** A hero tile by its label: the whole tile (label, value, sub-line). */
const tile = (label: string) => screen.getByText(label).parentElement!
/** The tile's value line, which carries the tile's colour. */
const value = (label: string) => tile(label).children[1] as HTMLElement
/** The tile's sub-line. */
const sub = (label: string) => tile(label).children[2]!.textContent

/** A gauge by its label: its readout and unit, and the colour of its ring. */
function gauge(label: string) {
  const g = screen.getByText(label).parentElement!
  return {
    text: g.querySelector('.gauge__center')!.textContent,
    ring: g.querySelectorAll('circle')[1]!.getAttribute('stroke')
  }
}

/** A Stream Health card's value, by its label. */
const health = (label: string) => screen.getByText(label).nextElementSibling as HTMLElement

describe('T27 Overview hero tiles and gauges (B56, B57)', () => {
  it.each<[string, Scenario, string, string, string]>([
    ['no board, stopped', {}, 'No device', 'stream stopped', 'var(--muted)'],
    [
      'connected, relaying',
      { device: connected(), relay: { running: true, stream: 'connected' } },
      'Connected',
      'Gateway · relaying',
      'var(--green)'
    ],
    [
      'connected, stopped',
      { device: connected() },
      'Connected',
      'Gateway · stream stopped',
      'var(--green)'
    ],
    [
      'reconnecting while relaying',
      { device: link('reconnecting'), relay: { running: true, stream: 'connected' } },
      'Reconnecting',
      'relay waiting — resumes when it connects',
      'var(--gold)'
    ],
    ['scanning', { device: link('scanning') }, 'Scanning', 'stream stopped', 'var(--blue-2)'],
    [
      'released',
      { device: link('disconnected') },
      'Disconnected',
      'stream stopped',
      'var(--muted)'
    ],
    ['port error', { device: link('error') }, 'Error', 'stream stopped', 'var(--red)']
  ])(
    'Link tile, %s: the device link, with the relay underneath',
    async (_, scenario, v, s, color) => {
      await renderScenario(<Overview />, scenario)
      expect(value('Link')).toHaveTextContent(v)
      expect(sub('Link')).toBe(s)
      expect(value('Link').style.color).toBe(color)
    }
  )

  it('every device state has its Link value', async () => {
    const states: [DeviceState, string][] = [
      ['connected', 'Connected'],
      ['scanning', 'Scanning'],
      ['reconnecting', 'Reconnecting'],
      ['no-device', 'No device'],
      ['disconnected', 'Disconnected'],
      ['error', 'Error']
    ]
    const { sky } = await renderScenario(<Overview />)
    for (const [state, label] of states) {
      sky.emitScenario({ device: link(state) })
      expect(value('Link')).toHaveTextContent(label)
    }
  })

  it('Link tile opens the Connection tab; Cockpit tile the Cockpit tab', async () => {
    const { user } = await renderScenario(<App />, { device: connected() })
    await user.click(screen.getByRole('button', { name: /^Link/ }))
    expect(screen.getByRole('tab', { name: 'Connection' })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('tab', { name: 'Overview' }))
    await user.click(screen.getByRole('button', { name: /^Cockpit/ }))
    expect(screen.getByRole('tab', { name: 'Cockpit' })).toHaveAttribute('aria-selected', 'true')
  })

  it('Aircraft tile: NONE until DCS names one, by metadata', async () => {
    const { sky } = await renderScenario(<Overview />, { device: connected() })
    expect(value('Aircraft')).toHaveTextContent('NONE')
    expect(sub('Aircraft')).toBe('_ACFT_NAME · metadata')
    sky.emitScenario({ aircraft: { name: 'A-4E-C', inferred: false, supported: true } })
    expect(value('Aircraft')).toHaveTextContent('A-4E-C')
    expect(sub('Aircraft')).toBe('_ACFT_NAME · metadata')
    expect(value('Aircraft').style.color).toBe('var(--text)')
  })

  it('Aircraft tile: an aircraft inferred from the address range says so', async () => {
    await renderScenario(<Overview />, {
      aircraft: { name: 'A-4E-C', inferred: true, supported: true }
    })
    expect(value('Aircraft')).toHaveTextContent('A-4E-C')
    expect(sub('Aircraft')).toBe('inferred · address range')
  })

  it('Aircraft tile: another aircraft is gold, with the A-4E-C-only banner', async () => {
    await renderScenario(<Overview />, {
      aircraft: { name: 'F-16C_50', inferred: false, supported: false }
    })
    expect(value('Aircraft')).toHaveTextContent('F-16C_50')
    expect(value('Aircraft').style.color).toBe('var(--gold)')
    expect(
      screen.getByText((_, el) =>
        el?.classList.contains('warn-banner')
          ? el.textContent ===
            '⚠ F-16C_50 loaded — named decode is A-4E-C only. Relaying & stats continue; the log shows raw addresses.'
          : false
      )
    ).toBeInTheDocument()
  })

  it.each([
    ['tcp-to-host', 'TCP', '10.0.0.7:7779 · remote'],
    ['loopback-multicast', 'Multicast', '239.255.50.10:5010 · local'],
    // The sub-line reads the multicast endpoint for Unicast too, today.
    ['unicast-listen', 'Unicast', '239.255.50.10:5010 · local']
  ] as const)('DCS Link tile, %s: "%s"', async (transport, v, s) => {
    await renderScenario(<Overview />, {
      config: { transport, host: '10.0.0.7', commandPort: 7779 }
    })
    expect(value('DCS Link')).toHaveTextContent(v)
    expect(sub('DCS Link')).toBe(s)
  })

  it('gauges: five idle readouts, "—", until the first telemetry tick', async () => {
    await renderScenario(<Overview />, { device: connected() })
    expect(['RPM', 'IAS', 'Flap', 'Press Alt', 'Fuel'].map((l) => gauge(l).text)).toEqual([
      '—% RPM',
      '—% FS',
      '—% DN',
      '—% FS',
      '—% QTY'
    ])
  })

  it('gauges: the values of the last tick; one DCS hasn’t exported stays "—"', async () => {
    await renderScenario(<Overview />, {
      device: connected(),
      relay: { running: true, stream: 'connected' },
      gauges: simTelemetry({ RPM: 0.85, D_FLAPS_IND: 0.5, D_FUEL: 0.6 })
    })
    expect(['RPM', 'IAS', 'Flap', 'Press Alt', 'Fuel'].map((l) => gauge(l).text)).toEqual([
      '85% RPM',
      '—kt',
      '50% DN',
      '—ft',
      '60% QTY'
    ])
  })

  it('Fuel is gold, and red under 25 %', async () => {
    const { sky } = await renderScenario(<Overview />, {
      device: connected(),
      relay: { running: true, stream: 'connected' },
      gauges: simTelemetry({ D_FUEL: 0.25 })
    })
    expect(gauge('Fuel')).toEqual({ text: '25% QTY', ring: 'var(--gold)' })
    sky.emitScenario({ gauges: simTelemetry({ D_FUEL: 0.24 }) })
    expect(gauge('Fuel')).toEqual({ text: '24% QTY', ring: 'var(--red)' })
    // The other rings keep their own colours.
    expect(gauge('RPM').ring).toBe('var(--blue)')
    expect(gauge('Flap').ring).toBe('var(--blue-2)')
    expect(gauge('Press Alt').ring).toBe('var(--blue-2)')
  })

  it('Stream Health: the stats tick; errors red once there is one', async () => {
    const { sky } = await renderScenario(<Overview />, {
      device: connected(),
      relay: { running: true, stream: 'connected' },
      stats: streamStats({
        bytesInPerSec: 2048,
        bytesOutPerSec: 300,
        framesPerSec: 30,
        uptimeSec: 3725,
        reconnects: 2,
        commandsPerSec: 3,
        commandsTotal: 1234,
        lastCommand: 'FLAPS_SW 1'
      })
    })
    expect(
      ['Bytes In', 'Bytes Out', 'Frames', 'Errors', 'Uptime', 'Reconnects'].map(
        (l) => health(l).textContent
      )
    ).toEqual(['2.0 KB/s', '300 B/s', '30/s', '0', '01:02:05', '2'])
    expect(health('Errors').style.color).toBe('var(--text)')
    expect(screen.getByText(/^CMD/)).toHaveTextContent('CMD 3/s · 1,234 total · last FLAPS_SW 1')

    sky.emitScenario({ stats: streamStats({ errors: 3 }) })
    expect(health('Errors')).toHaveTextContent('3')
    expect(health('Errors').style.color).toBe('var(--red)')
  })

  it('no stats yet: zeros, and no last command', async () => {
    await renderScenario(<Overview />)
    expect(within(screen.getByText(/^CMD/)).getByText('—')).toBeInTheDocument()
    expect(health('Errors').style.color).toBe('var(--text)')
  })
})
