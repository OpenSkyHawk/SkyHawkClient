// T14 — the app shell: title bar, tab bar, and the subscription to main that App starts on mount.
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App } from '../src/app/App'
import pkg from '../../../package.json'
import { renderScenario, settle } from './render'
import { skyhawk } from './skyhawk-mock'
import { connected, link } from './scenarios'

const TABS = ['Overview', 'Connection', 'Cockpit', 'Log', 'Serial', 'HID', 'Settings']

/** The tab bar's tabs, by name. */
const tabs = () => screen.getAllByRole('tab').map((t) => t.textContent)
const selectedTabs = () =>
  screen
    .getAllByRole('tab')
    .filter((t) => t.getAttribute('aria-selected') === 'true')
    .map((t) => t.textContent)

describe('T14 App shell (B43)', () => {
  it('the title bar: wordmark, the version, the Device indicator and the Relay pill', async () => {
    await renderScenario(<App />, { device: connected() })
    expect(screen.getByRole('banner')).toHaveTextContent(/^OPENSKYHAWKCLIENT/)
    expect(screen.getByText(`v${pkg.version}`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Gateway' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stopped' })).toBeInTheDocument()
  })

  it('seven tabs, Overview selected; a click switches the tab and its page', async () => {
    const { user } = await renderScenario(<App />, { device: connected() })
    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeInTheDocument()
    expect(tabs()).toEqual(TABS)
    expect(selectedTabs()).toEqual(['Overview'])

    await user.click(screen.getByRole('tab', { name: 'Settings' }))
    expect(selectedTabs()).toEqual(['Settings'])
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Cockpit' }))
    expect(selectedTabs()).toEqual(['Cockpit'])
    expect(screen.getByText('Attention')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Settings sections' })).toBeNull()
  })

  it('"SOURCE <mode>" shows the saved source mode', async () => {
    await renderScenario(<App />, { config: { sourceMode: 'bridge' } })
    expect(screen.getByText('SOURCE')).toHaveTextContent('SOURCE bridge')
  })

  it('on mount App subscribes to main, takes main’s state, and follows its pushes', async () => {
    // Main is already up with the board connected when the window loads; nothing subscribed yet.
    const sky = skyhawk()
    sky.emitScenario({ device: connected(), config: { sourceMode: 'replay' } })
    expect(sky.on).not.toHaveBeenCalled()

    render(<App />)
    await settle()
    const channels = sky.on.mock.calls.map(([ch]) => ch)
    expect(channels).toEqual(
      expect.arrayContaining(['device:status', 'relay:state', 'nodes:model', 'events:batch'])
    )
    expect(sky.getStatus).toHaveBeenCalled()
    // The pulls answered: the pill and the source mode show main's state.
    expect(screen.getByRole('button', { name: 'Gateway' })).toBeInTheDocument()
    expect(screen.getByText('SOURCE')).toHaveTextContent('SOURCE replay')

    // A `device:status` push changes the pill.
    sky.emitScenario({ device: link('reconnecting') })
    expect(screen.getByRole('button', { name: 'Reconnecting' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Gateway' })).toBeNull()
  })
})
