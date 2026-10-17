// T24 — the Serial tab: the raw serial monitor, its rows and Clear.
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { Serial } from '../src/tabs/Serial'
import { renderScenario } from './render'
import { connected, serialFrame } from './scenarios'

const T = (s: number) => new Date(2026, 9, 16, 12, 0, s).getTime()

/** The listed chunks, top to bottom: time, direction, hex, ASCII. */
const rows = () =>
  screen.queryAllByText(/^(TX ▸|◂ RX)$/).map((dir) => dir.parentElement!.textContent)

const hex = (text: string) => Buffer.from(text, 'latin1').toString('hex')

describe('T24 Serial tab (B79)', () => {
  it('off: says how to start it', async () => {
    await renderScenario(<Serial />, { device: connected() })
    expect(
      screen.getByText('Serial monitor is off. Start it to see raw bytes both ways.')
    ).toBeInTheDocument()
    expect(screen.getByText('OFF')).toBeInTheDocument()
    expect(screen.getByText('0 frames')).toBeInTheDocument()
  })

  it('the toggle asks main to start and stop monitoring', async () => {
    const { user, sky } = await renderScenario(<Serial />, { device: connected() })
    await user.click(screen.getByRole('button', { name: 'Start monitor' }))
    expect(sky.setSerialMonitor).toHaveBeenLastCalledWith(true)
    expect(screen.getByText('MONITORING')).toBeInTheDocument()
    expect(
      screen.getByText('Monitoring — no serial traffic yet. (TX/RX needs a connected Gateway.)')
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '● Monitoring' }))
    expect(sky.setSerialMonitor).toHaveBeenLastCalledWith(false)
    expect(screen.getByText('OFF')).toBeInTheDocument()
  })

  it('lists what main forwards, newest first, as hex and ASCII', async () => {
    const { user, sky } = await renderScenario(<Serial />, { device: connected() })
    await user.click(screen.getByRole('button', { name: 'Start monitor' }))
    sky.emitScenario({
      serial: [
        serialFrame('tx', hex('Hello'), T(1)),
        serialFrame('rx', `${hex('_NODE_STATUS')}0d0a`, T(2))
      ]
    })
    expect(rows()).toEqual([
      '12:00:02.000◂ RX5F 4E 4F 44 45 5F 53 54 41 54 55 53 0D 0A_NODE_STATUS··',
      '12:00:01.000TX ▸48 65 6C 6C 6FHello'
    ])
    expect(screen.getByText('2 frames · TX host→device · RX device→host')).toBeInTheDocument()
    expect(screen.getByText('2 frames')).toBeInTheDocument()

    // A long chunk shows its first 48 bytes and how many more there were.
    sky.emitScenario({ serial: [serialFrame('rx', '41'.repeat(50), T(3))] })
    expect(rows()[0]).toBe(`12:00:03.000◂ RX${Array(48).fill('41').join(' ')} …+2${'A'.repeat(48)}`)
  })

  it('stopping keeps what was listed; Clear empties it', async () => {
    const { user, sky } = await renderScenario(<Serial />, { device: connected() })
    await user.click(screen.getByRole('button', { name: 'Start monitor' }))
    sky.emitScenario({ serial: [serialFrame('tx', hex('Hi'), T(1))] })
    await user.click(screen.getByRole('button', { name: '● Monitoring' }))
    expect(rows()).toEqual(['12:00:01.000TX ▸48 69Hi'])

    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(rows()).toEqual([])
    expect(screen.getByText('0 frames')).toBeInTheDocument()
  })
})
