// T6 — the title-bar Device indicator and its popover: link states and the Gateway's Health.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import type { DeviceState } from '@shared/ipc'
import { DevicePopover } from '../src/DevicePopover'
import { App } from '../src/App'
import { renderScenario } from './render'
import { PORT, connected, gateway, gatewayNotResponding, link } from './scenarios'

/** The indicator: the button that opens the Device link popover. */
const pill = () => screen.getByRole('button', { expanded: false })
const popover = () => screen.getByRole('dialog', { name: 'Device link' })

describe('T6 DevicePopover: link states and Gateway Health (B44, B42, B40)', () => {
  // Each state: the indicator's label, the popover's title, its line, and its button.
  const STATES: [DeviceState, string, string, string | null, string, boolean][] = [
    ['connected', 'Gateway', 'Connected', null, 'Disconnect', false],
    ['scanning', 'Scanning', 'Scanning…', 'Looking for the Gateway…', 'Disconnect', true],
    [
      'reconnecting',
      'Reconnecting',
      'Reconnecting',
      'Link dropped — reopening the port. A running relay keeps going.',
      'Disconnect',
      false
    ],
    [
      'no-device',
      'No device',
      'No device',
      'Nothing plugged in — it connects as soon as you plug it in.',
      'Disconnect',
      false
    ],
    [
      'disconnected',
      'Disconnected',
      'Disconnected',
      'Port released — other tools can use it until you press Connect.',
      'Connect',
      false
    ],
    [
      'error',
      'Error',
      'Error',
      `${PORT} would not open: boom. Retry, or replug the board.`,
      'Retry',
      false
    ]
  ]

  it.each(STATES)(
    '%s: indicator "%s", popover "%s"',
    async (state, label, title, line, btn, off) => {
      const { user } = await renderScenario(<DevicePopover />, {
        device: link(state, state === 'error' ? { detail: 'boom' } : {})
      })
      expect(pill()).toHaveTextContent(label)
      await user.click(pill())
      const dlg = popover()
      expect(within(dlg).getByText(title)).toBeInTheDocument()
      if (line) expect(within(dlg).getByText(line)).toBeInTheDocument()
      // The port shows in the popover only in the error line; connected keeps it in the tooltip.
      if (state !== 'error') expect(within(dlg).queryByText(new RegExp(PORT))).toBeNull()
      const action = within(dlg).getByRole('button', { name: btn })
      if (off) expect(action).toBeDisabled()
      else expect(action).toBeEnabled()
      // No Health row without a Gateway report.
      expect(within(dlg).queryByText('Health')).toBeNull()
    }
  )

  it('connected: the port is in the indicator’s tooltip', async () => {
    // contract (T6) says the popover has a port line while connected, dropped once the Gateway
    // reports health; today the popover has no port line while connected, with or without health
    // (#94 moved it to this tooltip and the Connection tab).
    await renderScenario(<DevicePopover />, { device: connected() })
    expect(pill()).toHaveAttribute('title', `Gateway connected · ${PORT}`)
  })

  it('another program holding the port reads "busy"', async () => {
    const { user } = await renderScenario(<DevicePopover />, {
      device: link('error', { detail: 'Resource busy' })
    })
    await user.click(pill())
    expect(
      within(popover()).getByText(`Port busy — another app has ${PORT} open. Close it, then Retry.`)
    ).toBeInTheDocument()
  })

  it('Connect / Retry / Disconnect ask main for the link', async () => {
    const { sky, user } = await renderScenario(<DevicePopover />, {
      device: link('disconnected')
    })
    await user.click(pill())
    await user.click(within(popover()).getByRole('button', { name: 'Connect' }))
    expect(sky.connectDevice).toHaveBeenCalledTimes(1)

    sky.emitScenario({ device: link('error', { detail: 'boom' }) })
    await user.click(within(popover()).getByRole('button', { name: 'Retry' }))
    expect(sky.connectDevice).toHaveBeenCalledTimes(2)

    sky.emitScenario({ device: connected() })
    await user.click(within(popover()).getByRole('button', { name: 'Disconnect' }))
    expect(sky.disconnectDevice).toHaveBeenCalledTimes(1)
  })

  it('a healthy Gateway: Health "OK · 42 °C", no "!"', async () => {
    const { user } = await renderScenario(<DevicePopover />, {
      device: connected(gateway())
    })
    expect(pill()).toHaveTextContent(/^Gateway$/)
    await user.click(pill())
    const dlg = popover()
    expect(within(dlg).getByText('Health')).toBeInTheDocument()
    expect(within(dlg).getByText('OK · 42 °C')).toBeInTheDocument()
    expect(within(dlg).getByText('Connected')).toBeInTheDocument()
  })

  it('a warning: "!" on the indicator, the Health row with its note', async () => {
    const { user } = await renderScenario(<DevicePopover />, {
      device: connected(gateway({ epvf: true }))
    })
    expect(pill()).toHaveTextContent('!Gateway')
    expect(pill()).toHaveAttribute(
      'title',
      `Gateway reports a problem · ${PORT} — click for details`
    )
    await user.click(pill())
    const dlg = popover()
    expect(within(dlg).getByText('Error-passive')).toBeInTheDocument()
    expect(within(dlg).getByText(/^Its CAN error count is high/)).toBeInTheDocument()
  })

  it('not responding: the title and line replace the link’s own; no Health row', async () => {
    const { user } = await renderScenario(<DevicePopover />, {
      device: connected(gatewayNotResponding())
    })
    expect(pill()).toHaveTextContent('!Gateway')
    await user.click(pill())
    const dlg = popover()
    expect(within(dlg).getByText('Not responding')).toBeInTheDocument()
    expect(
      within(dlg).getByText(
        'No answer for 5 s while the port is open. Unplug its USB cable and plug it back in.'
      )
    ).toBeInTheDocument()
    expect(within(dlg).queryByText('Connected')).toBeNull()
    expect(within(dlg).queryByText('Health')).toBeNull()
  })

  it('nothing about the Gateway while the link is down', async () => {
    const { user } = await renderScenario(<DevicePopover />, {
      device: link('reconnecting', { gateway: gateway({ boff: true }) })
    })
    expect(pill()).toHaveTextContent(/^Reconnecting$/)
    await user.click(pill())
    expect(within(popover()).queryByText('Health')).toBeNull()
    expect(within(popover()).queryByText('Bus-off')).toBeNull()
  })

  it('Esc closes it and focus returns to the indicator', async () => {
    const { user } = await renderScenario(<DevicePopover />, { device: connected(gateway()) })
    await user.click(pill())
    expect(popover()).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(pill()).toHaveFocus()
  })

  it('a click outside (the scrim) closes it and focus returns to the indicator', async () => {
    const { container, user } = await renderScenario(<DevicePopover />, {
      device: connected(gateway())
    })
    await user.click(pill())
    // The scrim has no role or text: it is the page behind the popover.
    const scrim = container.querySelector('.devpop__scrim')
    expect(scrim).not.toBeNull()
    await user.click(scrim!)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(pill()).toHaveFocus()
  })

  it('"Connection tab →" opens the Connection tab and closes the popover', async () => {
    const { user } = await renderScenario(<App />, { device: connected() })
    await user.click(screen.getByRole('button', { name: 'Gateway' }))
    await user.click(within(popover()).getByRole('button', { name: 'Connection tab →' }))
    expect(screen.getByRole('tab', { name: 'Connection' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('dialog', { name: 'Device link' })).toBeNull()
  })
})
