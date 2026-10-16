// T15 — the title-bar Relay pill: the one on/off for the DCS-BIOS stream.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import { RelayPill } from '../src/RelayPill'
import { renderScenario, settle } from './render'
import { connected, link } from './scenarios'

/** The pill: the only button until the blocked callout opens. */
const pill = () => screen.getByRole('button', { name: /^!?(Stopped|Relaying)$/ })

describe('T15 RelayPill (B45, B47)', () => {
  it('stopped: "Stopped", and a click asks main to start', async () => {
    const { sky, user } = await renderScenario(<RelayPill />, { device: connected() })
    expect(pill()).toHaveTextContent(/^Stopped$/)
    expect(pill()).toHaveAttribute('title', 'DCS-BIOS stream stopped — click to start')
    expect(pill()).toHaveAttribute('aria-disabled', 'false')
    await user.click(pill())
    await settle()
    // Settings are saved first, then the relay starts.
    expect(sky.setConfig).toHaveBeenCalledTimes(1)
    expect(sky.startRelay).toHaveBeenCalledTimes(1)
    expect(sky.setConfig.mock.invocationCallOrder[0]!).toBeLessThan(
      sky.startRelay.mock.invocationCallOrder[0]!
    )
    // It reads Relaying at once, before main's relay:state arrives.
    expect(pill()).toHaveTextContent(/^Relaying$/)
  })

  it('relaying and delivering: "Relaying"; a click asks main to stop', async () => {
    const { sky, user } = await renderScenario(<RelayPill />, {
      device: connected(),
      relay: { running: true, stream: 'connected' }
    })
    expect(pill()).toHaveTextContent(/^Relaying$/)
    expect(pill()).toHaveAttribute(
      'title',
      'DCS-BIOS stream · connected · 127.0.0.1:7778 — click to stop'
    )
    await user.click(pill())
    expect(sky.stopRelay).toHaveBeenCalledTimes(1)
    expect(pill()).toHaveTextContent(/^Stopped$/)
  })

  it('relaying while the stream is still connecting: it says what it waits for', async () => {
    const { sky } = await renderScenario(<RelayPill />, {
      device: connected(),
      relay: { running: true, stream: 'connecting' }
    })
    expect(pill()).toHaveTextContent(/^Relaying$/)
    expect(pill()).toHaveAttribute(
      'title',
      'Relaying — waiting for DCS-BIOS (connecting) · 127.0.0.1:7778 — click to stop'
    )
    // The stream connects: the wait is over.
    sky.emitScenario({ relay: { running: true, stream: 'connected' } })
    expect(pill()).toHaveAttribute(
      'title',
      'DCS-BIOS stream · connected · 127.0.0.1:7778 — click to stop'
    )
  })

  it('Bridge relaying while the board is gone: waiting for the Gateway', async () => {
    await renderScenario(<RelayPill />, {
      config: { sourceMode: 'bridge' },
      device: link('reconnecting'),
      relay: { running: true, stream: 'connected' }
    })
    expect(pill()).toHaveTextContent(/^Relaying$/)
    expect(pill()).toHaveAttribute(
      'title',
      'Relaying — waiting for the Gateway (device link reconnecting). Resumes when it connects — click to stop'
    )
  })

  it('Bridge without a board: blocked with "!", and a click explains instead of starting', async () => {
    const { sky, user } = await renderScenario(<RelayPill />, {
      config: { sourceMode: 'bridge' },
      device: link('no-device')
    })
    expect(pill()).toHaveTextContent(/^!Stopped$/)
    expect(pill()).toHaveAttribute('aria-disabled', 'true')
    expect(pill()).toHaveAttribute('title', 'Connect the Gateway to start the relay.')
    expect(screen.queryByRole('alertdialog')).toBeNull()

    await user.click(pill())
    const callout = screen.getByRole('alertdialog', { name: "Can't start the relay" })
    expect(
      within(callout).getByText(
        "The Gateway isn't connected, and the relay delivers to it. Connect first."
      )
    ).toBeInTheDocument()
    expect(sky.startRelay).not.toHaveBeenCalled()

    // Connect only connects: Start stays a second step.
    await user.click(within(callout).getByRole('button', { name: 'Connect' }))
    expect(sky.connectDevice).toHaveBeenCalledTimes(1)
    expect(sky.startRelay).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('the board arriving lifts the block and closes the callout', async () => {
    const { sky, user } = await renderScenario(<RelayPill />, {
      config: { sourceMode: 'bridge' },
      device: link('no-device')
    })
    await user.click(pill())
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    sky.emitScenario({ device: connected() })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(pill()).toHaveTextContent(/^Stopped$/)
    expect(pill()).toHaveAttribute('aria-disabled', 'false')
  })

  it('Esc closes the callout and focus returns to the pill', async () => {
    const { user } = await renderScenario(<RelayPill />, {
      config: { sourceMode: 'bridge' },
      device: link('no-device')
    })
    await user.click(pill())
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(pill()).toHaveFocus()
  })

  it('Monitor starts without a board', async () => {
    const { sky, user } = await renderScenario(<RelayPill />, { device: link('no-device') })
    expect(pill()).toHaveAttribute('aria-disabled', 'false')
    await user.click(pill())
    await settle()
    expect(sky.startRelay).toHaveBeenCalledTimes(1)
  })

  it('when main refuses Start, the pill goes back to Stopped', async () => {
    // Replay with nothing loaded: the pill lets Start through, main refuses it.
    const { sky, user } = await renderScenario(<RelayPill />, {
      config: { sourceMode: 'replay' },
      device: connected()
    })
    expect(pill()).toHaveAttribute('title', 'Replay stopped — click to play')
    sky.startRelay.mockResolvedValueOnce({ ok: false, error: 'No capture loaded' })
    await user.click(pill())
    await settle()
    expect(sky.startRelay).toHaveBeenCalledTimes(1)
    expect(pill()).toHaveTextContent(/^Stopped$/)
  })
})
