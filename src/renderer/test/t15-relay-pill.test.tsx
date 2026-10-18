// T15 — the title-bar Relay pill: the one on/off for the DCS-BIOS stream.
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { RelayPill } from '../src/app/titlebar/RelayPill'
import { renderScenario, settle } from './render'
import { connected, link } from './scenarios'

/** The pill: the only button. */
const pill = () => screen.getByRole('button', { name: /^(Stopped|Relaying)$/ })

describe('T15 RelayPill (B45, B47)', () => {
  it('stopped: "Stopped", and a click asks main to start', async () => {
    const { sky, user } = await renderScenario(<RelayPill />, { device: connected() })
    expect(pill()).toHaveTextContent(/^Stopped$/)
    expect(pill()).toHaveAttribute('title', 'DCS-BIOS stream stopped — click to start')
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

  it('N3: a driven Replay relaying while the board is gone: waiting for the Gateway', async () => {
    await renderScenario(<RelayPill />, {
      config: { sourceMode: 'replay', replayDriveSerial: true },
      device: link('reconnecting'),
      relay: { running: true, stream: 'connected' }
    })
    expect(pill()).toHaveAttribute(
      'title',
      'Relaying — waiting for the Gateway (device link reconnecting). Resumes when it connects — click to stop'
    )
    expect(pill()).toHaveClass('pill--wait')
  })

  it('N3: an undriven Replay never uses the board, so it just plays', async () => {
    await renderScenario(<RelayPill />, {
      config: { sourceMode: 'replay', replayDriveSerial: false },
      device: link('reconnecting'),
      relay: { running: true, stream: 'connected' }
    })
    expect(pill()).toHaveAttribute('title', 'Replay · playing — click to stop')
    expect(pill()).not.toHaveClass('pill--wait')
  })

  it('N2: Monitor relaying with no board says nothing about the Gateway', async () => {
    await renderScenario(<RelayPill />, {
      device: link('no-device'),
      relay: { running: true, stream: 'connected' }
    })
    expect(pill()).toHaveAttribute(
      'title',
      'DCS-BIOS stream · connected · 127.0.0.1:7778 — click to stop'
    )
  })

  // #159: it used to show a "!" and answer a click with a "Can't start" callout, never starting.
  it.each([
    ['Bridge', { sourceMode: 'bridge' as const }],
    ['a driven Replay', { sourceMode: 'replay' as const, replayDriveSerial: true }]
  ])('%s without a board: a click starts, and the pill waits for the Gateway', async (_, cfg) => {
    const { sky, user } = await renderScenario(<RelayPill />, {
      config: cfg,
      device: link('no-device')
    })
    expect(pill()).toHaveTextContent(/^Stopped$/)
    await user.click(pill())
    await settle()
    expect(sky.startRelay).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(pill()).toHaveTextContent(/^Relaying$/)
    expect(pill()).toHaveClass('pill--wait')
    expect(pill()).toHaveAttribute(
      'title',
      'Relaying — waiting for the Gateway (device link no device). Resumes when it connects — click to stop'
    )
    // The board arrives: no further click, the wait for it is over.
    sky.emitScenario({ device: connected() })
    expect(pill()).toHaveTextContent(/^Relaying$/)
    expect(pill().getAttribute('title')).not.toMatch(/waiting for the Gateway/)
    expect(sky.startRelay).toHaveBeenCalledTimes(1)
  })

  it('Monitor starts without a board', async () => {
    const { sky, user } = await renderScenario(<RelayPill />, { device: link('no-device') })
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
