// T28 — Connection: the device card and the relay controls (source mode, capture, DCS link,
// record, Start / Stop).
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { USB_IDENTITY } from '@shared/firmware'
import { Connection } from '../src/app/connection/Connection'
import { App } from '../src/app/App'
import { renderScenario, settle } from './render'
import { connected, link, PORT } from './scenarios'

const HINT = {
  bridge:
    'Full relay — Gateway serial ↔ DCS-BIOS, plus HID. Replaces socat / connect-serial-port.cmd.',
  monitor:
    'Read DCS-BIOS off the LAN to inspect/test the stream — nothing is sent to the device. The device link, HID and node status stay up.',
  replay:
    'No DCS — feed the parser/UI from a recorded capture; optionally drive the Gateway over the same link.'
}

/** The board's USB ids as the card prints them, e.g. `0x2E8A / 0x4134` (from the synced identity). */
const hex4 = (n: number) => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`
const VID_PID = `${hex4(USB_IDENTITY.vid)} / ${hex4(USB_IDENTITY.pid)}`

/** A device-card row's value, by its key. */
const devRow = (k: string) => screen.getByText(k).nextElementSibling!.textContent
const startBtn = () => screen.getByRole('button', { name: /^(Start|Stop) relay$/ })
/** The line under Start / Stop. */
const waitnote = () => startBtn().nextElementSibling?.textContent ?? null
const mode = (m: 'Bridge' | 'Monitor' | 'Replay') => screen.getByRole('button', { name: m })
/** What the last settings save sent main. */
const lastSaved = (sky: Awaited<ReturnType<typeof renderScenario>>['sky']) =>
  sky.setConfig.mock.lastCall?.[0]

describe('T28 Connection device card and relay controls (B61, B62)', () => {
  it('device card, no board yet: only the VID/PID target', async () => {
    await renderScenario(<Connection />, { device: link('no-device') })
    expect(devRow('Identity')).toBe('— no device')
    expect(devRow('VID / PID')).toBe(`${VID_PID} · target`)
    expect(devRow('Serial port')).toBe('waiting for the board…')
    expect(devRow('Interfaces')).toBe('—')
    expect(screen.getByText('No device')).toBeInTheDocument()
  })

  it('device card, connected: identity, VID/PID, port, CDC + HID; Disconnect asks main', async () => {
    const { sky, user } = await renderScenario(<Connection />, { device: connected() })
    expect(devRow('Identity')).toBe(USB_IDENTITY.product)
    expect(devRow('VID / PID')).toBe(VID_PID)
    expect(devRow('Serial port')).toBe(PORT)
    expect(devRow('Interfaces')).toBe('CDC serial + HID')
    await user.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(sky.disconnectDevice).toHaveBeenCalledTimes(1)
  })

  it('device card, released: Connect asks main; auto-connect off links to Settings › Connection', async () => {
    const { sky, user } = await renderScenario(<App />, {
      device: link('disconnected'),
      config: { autoConnect: false }
    })
    await user.click(screen.getByRole('tab', { name: 'Connection' }))
    expect(
      screen.getByText(/^Automatic connection is off, so the port stays free for other tools/)
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(sky.connectDevice).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Settings › Connection' }))
    expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true')
  })

  it('device card, port busy: Retry, and the "open in another app" note', async () => {
    const { sky, user } = await renderScenario(<Connection />, {
      device: link('error', { detail: 'Resource busy' })
    })
    expect(devRow('Serial port')).toBe(`${PORT} · busy`)
    expect(
      screen.getByText(`${PORT} is open in another app (socat?). Close it, then Retry.`)
    ).toBeInTheDocument()
    // contract B61 says the "busy" note carries a Settings link; today only the released-with-
    // auto-connect-off note does (above), and the busy note has none.
    expect(screen.queryByRole('button', { name: 'Settings › Connection' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(sky.connectDevice).toHaveBeenCalledTimes(1)
  })

  it('device card, scanning: the button is greyed out', async () => {
    await renderScenario(<Connection />, { device: link('scanning') })
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled()
  })

  it('source mode buttons: each shows its hint and saves the mode', async () => {
    const { sky, user } = await renderScenario(<Connection />, { device: connected() })
    expect(screen.getByText(HINT.monitor)).toBeInTheDocument()
    await user.click(mode('Bridge'))
    expect(screen.getByText(HINT.bridge)).toBeInTheDocument()
    expect(lastSaved(sky)).toMatchObject({ sourceMode: 'bridge' })
    await user.click(mode('Replay'))
    expect(screen.getByText(HINT.replay)).toBeInTheDocument()
    expect(lastSaved(sky)).toMatchObject({ sourceMode: 'replay' })
  })

  it('Replay: Load capture… asks main, and the loaded file is ready to play', async () => {
    const { sky, user } = await renderScenario(<Connection />, {
      device: connected(),
      config: { sourceMode: 'replay' }
    })
    expect(
      screen.getByText(
        'No capture loaded. Load a recorded session to replay it with no DCS running.'
      )
    ).toBeInTheDocument()
    // Replay has no Record card.
    expect(screen.queryByRole('button', { name: /recording/ })).toBeNull()
    sky.openReplay.mockResolvedValueOnce({
      loaded: true,
      path: '/Users/me/captures/carrier-trap.skycap',
      events: 1200,
      durationMs: 45_300
    })
    await user.click(screen.getByRole('button', { name: 'Load capture…' }))
    await settle()
    expect(sky.openReplay).toHaveBeenCalledTimes(1)
    expect(screen.getByText('carrier-trap.skycap').parentElement).toHaveTextContent(
      'carrier-trap.skycap · 1200 events · 45.3s — press Start to play.'
    )
  })

  it('Replay: the Drive Gateway toggle saves, and without a board it blocks Start', async () => {
    const { sky, user } = await renderScenario(<Connection />, {
      device: link('no-device'),
      config: { sourceMode: 'replay' }
    })
    const drive = screen.getByText('Drive Gateway').parentElement!.nextElementSibling!
    expect(drive).toHaveAttribute('aria-pressed', 'false')
    expect(startBtn()).toBeEnabled()
    await user.click(drive)
    expect(drive).toHaveAttribute('aria-pressed', 'true')
    expect(lastSaved(sky)).toMatchObject({ replayDriveSerial: true })
    expect(startBtn()).toBeDisabled()
    expect(waitnote()).toBe(
      'Connect the Gateway to play the capture to it, or turn Drive Gateway off.'
    )
  })

  it('DCS link: host and port are saved on commit (blur / Enter), transport as picked', async () => {
    const { sky, user } = await renderScenario(<Connection />, { device: connected() })
    const host = screen.getByText('DCS host').nextElementSibling as HTMLInputElement
    const port = screen.getByText('Port').nextElementSibling as HTMLInputElement
    expect([host.value, port.value]).toEqual(['127.0.0.1', '7778'])
    await user.clear(host)
    await user.type(host, '10.0.0.7')
    expect(sky.setConfig, 'N5: typing saves nothing').not.toHaveBeenCalled()
    await user.tab() // the host's blur commits it
    expect(lastSaved(sky)).toMatchObject({ host: '10.0.0.7', commandPort: 7778 })
    await user.clear(port)
    await user.type(port, '7779')
    expect(sky.setConfig).toHaveBeenCalledTimes(1)
    await user.keyboard('{Enter}')
    expect(lastSaved(sky)).toMatchObject({ host: '10.0.0.7', commandPort: 7779 })
    await user.tab() // the blur after Enter: nothing new typed, nothing sent again
    expect(sky.setConfig).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole('button', { name: /^Loopback multicast/ }))
    expect(lastSaved(sky)).toMatchObject({ transport: 'loopback-multicast' })
    await user.click(screen.getByRole('button', { name: /^Unicast listen/ }))
    expect(lastSaved(sky)).toMatchObject({ transport: 'unicast-listen' })
    await user.click(screen.getByRole('button', { name: /^TCP to host/ }))
    expect(lastSaved(sky)).toMatchObject({ transport: 'tcp-to-host' })
  })

  it('DCS link: a junk port shows main’s error and saves nothing; a good one saves', async () => {
    const { sky, user } = await renderScenario(<Connection />, { device: connected() })
    const port = screen.getByText('Port').nextElementSibling as HTMLInputElement
    await user.clear(port)
    await user.type(port, '77a{Enter}')
    await settle()
    expect(port).toHaveValue('77a')
    expect(port).toHaveAttribute('aria-invalid', 'true')
    expect(
      screen.getByText('Not a port. Enter a whole number from 1 to 65535.')
    ).toBeInTheDocument()
    expect(sky.setConfig, 'nothing saved, never a silent 7778').not.toHaveBeenCalled()

    await user.clear(port)
    await user.type(port, '7790{Enter}')
    await settle()
    expect(lastSaved(sky)).toMatchObject({ commandPort: 7790 })
    expect(port).toHaveAttribute('aria-invalid', 'false')
    expect(screen.queryByText(/^Not a port/)).toBeNull()
  })

  it('Record is greyed out until the relay runs', async () => {
    const { sky } = await renderScenario(<Connection />, { device: connected() })
    expect(screen.getByRole('button', { name: 'Start recording…' })).toBeDisabled()
    expect(screen.getByText('Start the relay first to enable recording.')).toBeInTheDocument()
    sky.emitScenario({ relay: { running: true, stream: 'connected' } })
    expect(screen.getByRole('button', { name: 'Start recording…' })).toBeEnabled()
    expect(
      screen.getByText('Capture a live session to replay later with no DCS running.')
    ).toBeInTheDocument()
  })

  it('Record while relaying asks main, and shows the running count', async () => {
    const { sky, user } = await renderScenario(<Connection />, {
      device: connected(),
      relay: { running: true, stream: 'connected' }
    })
    sky.toggleCapture.mockResolvedValueOnce({ recording: true, events: 42 })
    await user.click(screen.getByRole('button', { name: 'Start recording…' }))
    await settle()
    expect(sky.toggleCapture).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Stop recording · 42 events' })).toBeEnabled()
    expect(
      screen.getByText(
        'Recording live DCS-BIOS stream. Stop to save — replay the file on any machine with no DCS.'
      )
    ).toBeInTheDocument()
  })

  it('Bridge without a board: Start is greyed out, with the reason under it', async () => {
    await renderScenario(<Connection />, {
      device: link('no-device'),
      config: { sourceMode: 'bridge' }
    })
    expect(startBtn()).toHaveTextContent('Start relay')
    expect(startBtn()).toBeDisabled()
    expect(waitnote()).toBe('Connect the Gateway to start the relay.')
  })

  it('Monitor needs no board: Start asks main; relaying, the button stops it', async () => {
    const { sky, user } = await renderScenario(<Connection />, { device: link('no-device') })
    expect(startBtn()).toBeEnabled()
    expect(waitnote()).toBeNull()
    await user.click(startBtn())
    await settle()
    expect(sky.startRelay).toHaveBeenCalledTimes(1)
    expect(startBtn()).toHaveTextContent('Stop relay')
    await user.click(startBtn())
    expect(sky.stopRelay).toHaveBeenCalledTimes(1)
  })

  it('relaying but waiting: the waitnote says for what', async () => {
    const { sky } = await renderScenario(<Connection />, {
      device: connected(),
      config: { sourceMode: 'bridge' },
      relay: { running: true, stream: 'connecting' }
    })
    expect(startBtn()).toHaveTextContent('Stop relay')
    expect(startBtn()).toBeEnabled()
    expect(waitnote()).toBe('Relaying — waiting for DCS-BIOS (connecting).')
    sky.emitScenario({
      device: link('reconnecting'),
      relay: { running: true, stream: 'connected' }
    })
    // Still relaying: Stop stays available while it waits for the board.
    expect(startBtn()).toBeEnabled()
    expect(waitnote()).toBe('Relaying — waiting for the Gateway. Resumes when it connects.')
    sky.emitScenario({ device: connected() })
    expect(waitnote()).toBeNull()
  })

  it('N3: a driven Replay that loses the board says it waits for the Gateway', async () => {
    const { sky } = await renderScenario(<Connection />, {
      device: link('reconnecting'),
      config: { sourceMode: 'replay', replayDriveSerial: true },
      relay: { running: true, stream: 'connected' }
    })
    expect(startBtn()).toHaveTextContent('Stop relay')
    expect(waitnote()).toBe('Relaying — waiting for the Gateway. Resumes when it connects.')
    sky.emitScenario({ device: connected() })
    expect(waitnote()).toBeNull()
  })

  it('N2: Monitor relaying with no board has no waiting note', async () => {
    await renderScenario(<Connection />, {
      device: link('no-device'),
      relay: { running: true, stream: 'connected' }
    })
    expect(startBtn()).toHaveTextContent('Stop relay')
    expect(waitnote()).toBeNull()
  })

  it('a replay that ran out: "Replay ended"', async () => {
    await renderScenario(<Connection />, {
      device: connected(),
      config: { sourceMode: 'replay' },
      relay: { running: true, stream: 'ended' }
    })
    expect(waitnote()).toBe('Replay ended — Stop, or load another capture.')
  })
})
