import { describe, expect, it } from 'vitest'
import { gatewayStatus } from '@shared/gateway'
import type { NodeStatus } from '@shared/nodes'
import { gatewayView } from './gateway-view'
import { nodeStatus } from '../../test-fixtures/nodes'

const PORT = '/dev/cu.usbmodem1101'

const node0 = (over: Partial<NodeStatus> = {}): NodeStatus =>
  nodeStatus(0, { uptimeSec: 0, rxCount: 0, dieTempC: 42, nodeKind: 3, ...over })

const view = (over: Partial<NodeStatus> = {}, notResponding = false, port?: string) =>
  gatewayView(gatewayStatus(node0(over), notResponding), true, port)

describe('gatewayView — reads the status, never re-derives it', () => {
  it('nothing while the link is down, or before there is anything to say', () => {
    expect(gatewayView(gatewayStatus(node0({ boff: true }), false), false, PORT)).toEqual({})
    expect(gatewayView(undefined, true, PORT)).toEqual({})
  })

  it('healthy: the Health row only', () => {
    expect(view()).toEqual({ health: { text: 'OK · 42 °C' } })
  })

  it('a warning: gold pill with the port, Health row with its note, Attention — no alert', () => {
    const v = view({ overheat: true, dieTempC: 78 }, false, PORT)
    expect(v.pill).toEqual({
      cls: 'devind--warn',
      tip: `Gateway reports a problem · ${PORT} — click for details`
    })
    expect(v.health).toMatchObject({ text: 'Overheat · 78 °C', tone: 'warn' })
    expect(v.health?.note).toMatch(/temperature trip/)
    expect(v.attention).toEqual({ flag: 'Overheat · 78 °C', state: 'warn' })
    expect(v.alert).toBeUndefined()
  })

  it('bus-off: red pill, Health row, the Overview alert, an offline Attention item', () => {
    const v = view({ boff: true })
    expect(v.pill?.cls).toBe('devind--err')
    expect(v.pill?.tip).toBe('Gateway reports a problem — click for details')
    expect(v.health).toMatchObject({ text: 'Bus-off', tone: 'err' })
    expect(v.alert?.head).toBe('The Gateway can’t reach your panels')
    expect(v.attention).toEqual({ flag: 'Bus-off', state: 'off' })
  })

  it('not responding: popover title and line instead of the Health row', () => {
    const v = view({ overheat: true }, true)
    expect(v.title).toBe('Not responding')
    expect(v.meta).toBe(
      'No answer for 5 s while the port is open. Unplug its USB cable and plug it back in.'
    )
    expect(v.health).toBeUndefined()
    expect(v.alert?.head).toBe('Gateway not responding')
    expect(v.attention).toEqual({ flag: 'Not responding', state: 'off' })
  })
})
