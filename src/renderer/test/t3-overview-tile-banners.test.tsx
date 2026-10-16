// T3 — Overview: the Cockpit tile, the attention banner and the Gateway alert.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import { Overview } from '../src/tabs/Overview'
import { Cockpit } from '../src/tabs/Cockpit'
import { DevicePopover } from '../src/DevicePopover'
import { renderScenario } from './render'
import { connected, gateway, model, newBoard, offline, outage, panel, pdu } from './scenarios'

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0)

/**
 * Five boards in your cockpit, one up: PDU_Left. PDU_Right (#4) went down with Right_Navigation
 * (#2); Center_Armament (#1) and PDU_Center (#5) are offline on their own.
 */
const fourDown = () =>
  model(
    [
      panel(1, 'Center_Armament', offline()),
      panel(2, 'Right_Navigation', { pduId: 4, ...offline() }),
      pdu(3, 'PDU_Left'),
      pdu(4, 'PDU_Right', offline()),
      pdu(5, 'PDU_Center', offline())
    ],
    [outage(4, [2], 1)]
  )

/** The Overview's Cockpit tile. */
const cockpitTile = () => screen.getByRole('button', { name: /^Cockpit/ })

describe('T3 Overview: Cockpit tile and banners (B58, B59, B42, X1)', () => {
  it('the tile counts boards up out of your cockpit, with the worst symbol, W and PDUs', async () => {
    await renderScenario(<Overview />, { device: connected(), model: fourDown() })
    const tile = cockpitTile()
    expect(within(tile).getByText('1 / 5')).toBeInTheDocument()
    expect(within(tile).getByText('✕')).toBeInTheDocument()
    expect(within(tile).getByText('nodes up · — W · 3 PDUs')).toBeInTheDocument()
  })

  it('the banner names the offline boards in Attention order, an outage as "PDU + N node"', async () => {
    await renderScenario(<Overview />, { device: connected(), model: fourDown() })
    const banner = screen.getByRole('status')
    expect(within(banner).getByText('4 nodes need attention')).toBeInTheDocument()
    expect(banner).toHaveTextContent(
      '⚠ 4 nodes need attention — 4 offline (PDU_Right + 1 node, Center_Armament, PDU_Center).'
    )
    expect(within(banner).getByRole('button', { name: 'Open Cockpit' })).toBeInTheDocument()
  })

  it('the banner is hidden while Settings › Cockpit turns it off', async () => {
    await renderScenario(<Overview />, {
      device: connected(),
      model: fourDown(),
      config: { attentionBanner: false }
    })
    expect(screen.queryByText(/need.? attention/)).toBeNull()
    // The tile still says it.
    expect(within(cockpitTile()).getByText('1 / 5')).toBeInTheDocument()
  })

  it('a Gateway bus-off is a red alert, first in the group; Details opens the Device popover', async () => {
    const { user } = await renderScenario(
      <>
        <DevicePopover />
        <Overview />
      </>,
      { device: connected(gateway({ boff: true })), model: fourDown() }
    )
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(
      'The Gateway can’t reach your panels — its cockpit (CAN) side went bus-off, so panel inputs aren’t reaching DCS.'
    )
    // Before the board banner.
    const banner = screen.getByRole('status')
    expect(alert.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    expect(screen.queryByRole('dialog', { name: 'Device link' })).toBeNull()
    await user.click(within(alert).getByRole('button', { name: 'Details' }))
    expect(screen.getByRole('dialog', { name: 'Device link' })).toBeInTheDocument()
  })

  it('a Gateway that only warns gives no alert', async () => {
    await renderScenario(<Overview />, {
      device: connected(gateway({ epvf: true })),
      model: model([panel(1, 'Center_Armament')])
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('the Overview doesn’t count a stray (X1 today)', async () => {
    // contract D1 says strays show on every tab; today the Overview ignores them: the Cockpit
    // tile reads "no nodes known" and no banner shows, while the Cockpit lists it as a warning.
    await renderScenario(<Overview />, {
      device: connected(),
      model: model([newBoard(9, T0 - 60_000, { identified: 'bridge' })])
    })
    const tile = cockpitTile()
    expect(within(tile).getByText('—')).toBeInTheDocument()
    expect(within(tile).getByText('no nodes known')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('its counts equal the Cockpit band for the same model', async () => {
    const { unmount } = await renderScenario(<Overview />, {
      device: connected(),
      model: fourDown()
    })
    expect(within(cockpitTile()).getByText('1 / 5')).toBeInTheDocument()
    unmount()
    await renderScenario(<Cockpit />, { device: connected(), model: fourDown() })
    expect(screen.getByText('Nodes online').parentElement).toHaveTextContent(
      '0 warning · 4 offline'
    )
    expect(screen.getByText('/ 5')).toBeInTheDocument()
  })
})
