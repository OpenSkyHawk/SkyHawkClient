// T31 — Settings › Connection and Settings › Diagnostics.
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import type { AppConfig } from '@shared/config'
import { Settings } from '../src/app/settings/Settings'
import { renderScenario, settle } from './render'
import { connected, link } from './scenarios'

/** A settings row's control, by the row's label. */
const control = (label: string) =>
  screen.getByText(label).parentElement!.nextElementSibling!.firstElementChild as HTMLElement
/** A settings row's description, by the row's label. */
const desc = (label: string) => screen.getByText(label).nextElementSibling!.textContent

async function openSettings(section?: RegExp, config?: Partial<AppConfig>) {
  const r = await renderScenario(<Settings />, {
    device: link('disconnected'),
    ...(config && { config })
  })
  if (section) {
    await r.user.click(screen.getByRole('button', { name: section }))
    await settle()
  }
  /** What the last settings save sent main. */
  const saved = () => r.sky.setConfig.mock.lastCall?.[0]
  return { ...r, saved }
}

describe('T31 Settings › Connection + Diagnostics (B86, B91)', () => {
  it('Connection is the section that opens; it shows the saved source mode, host and port', async () => {
    await openSettings(undefined, { sourceMode: 'bridge', host: '10.0.0.7', commandPort: 7779 })
    expect(screen.getByRole('button', { name: /^Connection/ })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(control('Source mode')).toHaveTextContent('bridge')
    expect(control('DCS host')).toHaveValue('10.0.0.7')
    expect(control('Command port')).toHaveValue('7779')
  })

  it('the DCS host and command port are saved on commit (blur / Enter), not per keystroke', async () => {
    const { sky, user, saved } = await openSettings()
    await user.clear(control('DCS host'))
    await user.type(control('DCS host'), '192.168.1.20')
    expect(sky.setConfig, 'N5: typing saves nothing').not.toHaveBeenCalled()
    await user.keyboard('{Enter}')
    expect(saved()).toMatchObject({ host: '192.168.1.20' })
    await user.clear(control('Command port'))
    await user.type(control('Command port'), '7780')
    expect(sky.setConfig).toHaveBeenCalledTimes(1)
    await user.tab()
    expect(saved()).toMatchObject({ host: '192.168.1.20', commandPort: 7780 })
  })

  it('a junk command port: main’s error under the card, nothing saved', async () => {
    const { sky, user, saved } = await openSettings(undefined, { commandPort: 7779 })
    await user.clear(control('Command port'))
    await user.type(control('Command port'), '99999')
    await user.tab()
    await settle()
    expect(control('Command port')).toHaveValue('99999')
    expect(control('Command port')).toHaveAttribute('aria-invalid', 'true')
    expect(
      screen.getByText('Not a port. Enter a whole number from 1 to 65535.')
    ).toBeInTheDocument()
    expect(sky.setConfig).not.toHaveBeenCalled()
    await user.clear(control('Command port'))
    await user.type(control('Command port'), '7781{Enter}')
    await settle()
    expect(saved()).toMatchObject({ commandPort: 7781 })
    expect(screen.queryByText(/^Not a port/)).toBeNull()
  })

  it('Connect automatically: the toggle saves the setting either way', async () => {
    // Turning it on while the link is down also connects at once — main does that when the
    // setting arrives (SESSION seam); the renderer only saves it.
    const { sky, user, saved } = await openSettings(undefined, { autoConnect: false })
    const toggle = control('Connect automatically')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(saved()).toMatchObject({ autoConnect: true })
    expect(sky.connectDevice).not.toHaveBeenCalled()
    await user.click(toggle)
    expect(saved()).toMatchObject({ autoConnect: false })
  })

  it('Record session asks main, and says it is recording', async () => {
    const { sky, user } = await openSettings()
    expect(desc('Record session')).toBe('Capture the DCS-BIOS stream to a file for replay')
    // X12: Record only while relaying, as the Connection tab's Record card (contract B62).
    expect(screen.getByRole('button', { name: '● Record' })).toBeDisabled()
    sky.emitScenario({ relay: { running: true, stream: 'connected' } })
    expect(screen.getByRole('button', { name: '● Record' })).toBeEnabled()
    sky.toggleCapture.mockResolvedValueOnce({ recording: true, events: 7 })
    await user.click(screen.getByRole('button', { name: '● Record' }))
    await settle()
    expect(sky.toggleCapture).toHaveBeenCalledTimes(1)
    expect(desc('Record session')).toBe('Recording · 7 events…')
    expect(screen.getByRole('button', { name: '■ Stop' })).toBeInTheDocument()
  })

  it('Diagnostics: the debug-logging toggle saves the setting', async () => {
    const { user, saved } = await openSettings(/^Diagnostics/)
    const toggle = control('Debug logging')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(saved()).toMatchObject({ debugMode: true })
  })

  it('Diagnostics: Dump asks main, and says where the ports went', async () => {
    const { sky, user } = await openSettings(/^Diagnostics/)
    expect(desc('Dump serial ports')).toBe(
      'Write every detected serial port (all USB fields) to the log'
    )
    sky.dumpSerialPorts.mockResolvedValueOnce({
      path: '/Users/me/Library/Logs/debug.log',
      count: 3
    })
    await user.click(screen.getByRole('button', { name: 'Dump' }))
    await settle()
    expect(sky.dumpSerialPorts).toHaveBeenCalledTimes(1)
    expect(desc('Dump serial ports')).toBe('Wrote 3 port(s) → /Users/me/Library/Logs/debug.log')
  })

  it('Diagnostics: Reveal asks main to show the debug log', async () => {
    const { sky, user } = await openSettings(/^Diagnostics/)
    await user.click(screen.getByRole('button', { name: 'Reveal' }))
    expect(sky.revealDebugLog).toHaveBeenCalledTimes(1)
  })

  it('a saved debug mode shows on', async () => {
    await openSettings(/^Diagnostics/, { debugMode: true })
    expect(control('Debug logging')).toHaveAttribute('aria-pressed', 'true')
  })

  it('the link state does not grey anything out', async () => {
    const { sky } = await openSettings(/^Diagnostics/)
    sky.emitScenario({ device: connected() })
    expect(screen.getByRole('button', { name: 'Dump' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Reveal' })).toBeEnabled()
  })
})
