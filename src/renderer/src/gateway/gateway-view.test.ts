import { describe, expect, it } from 'vitest'
import { gatewayStatus, shownHealth } from '../../../main/gateway/gateway-health'
import type { GatewayStatus } from '@shared/gateway'
import type { NodeStatus } from '@shared/nodes'
import { gatewayView as viewOf } from './gateway-view'
import { nodeStatus } from '../../../test-fixtures/nodes'

const PORT = '/dev/cu.usbmodem1101'

/** The Gateway as the surfaces show it: main's health, shown only while the link is up (R3.4a). */
const gatewayView = (g: GatewayStatus | undefined, linkUp: boolean, port?: string) =>
  viewOf(shownHealth(g, linkUp), port)

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

  it('a warning: gold pill with the port, Health row with its note — no alert', () => {
    const v = view({ overheat: true, dieTempC: 78 }, false, PORT)
    expect(v.pill).toEqual({
      cls: 'devind--warn',
      tip: `Gateway reports a problem · ${PORT} — click for details`
    })
    expect(v.health).toMatchObject({ text: 'Overheat · 78 °C', tone: 'warn' })
    expect(v.health?.note).toMatch(/temperature trip/)
    expect(v.alert).toBeUndefined()
  })

  it('bus-off: red pill, Health row, the Overview alert', () => {
    const v = view({ boff: true })
    expect(v.pill?.cls).toBe('devind--err')
    expect(v.pill?.tip).toBe('Gateway reports a problem — click for details')
    expect(v.health).toMatchObject({ text: 'Bus-off', tone: 'err' })
    expect(v.alert?.head).toBe('The Gateway can’t reach your panels')
  })

  it('not responding: popover title and line instead of the Health row', () => {
    const v = view({ overheat: true }, true)
    expect(v.title).toBe('Not responding')
    expect(v.meta).toBe(
      'No answer for 5 s while the port is open. Unplug its USB cable and plug it back in.'
    )
    expect(v.health).toBeUndefined()
    expect(v.alert?.head).toBe('Gateway not responding')
  })
})

describe('gatewayView — it recovered itself this boot (#169)', () => {
  const RECOVERED_TIP = 'The Gateway recovered itself since it was plugged in — click for details'

  it('gateway-health.recovered-alone: gold tag with its own tooltip, the row untoned, its line — no alert', () => {
    const v = viewOf(gatewayStatus(node0(), false, 'recovery'), PORT)
    expect(v.pill).toEqual({ cls: 'devind--warn', tip: RECOVERED_TIP })
    expect(v.health).toEqual({ text: 'OK · 42 °C', tone: undefined, note: undefined })
    expect(v.recovery).toBe(
      'Recovered itself since it was plugged in — restarted itself to recover its link to this computer.'
    )
    expect(v.alert).toBeUndefined()
    expect(v.pill?.tip).not.toMatch(/problem/)
  })

  it('before its cockpit side reports: no Health row, the line alone', () => {
    const v = viewOf(gatewayStatus(undefined, false, 're-plug'))
    expect(v.health).toBeUndefined()
    expect(v.recovery).toMatch(/^Recovered itself since it was plugged in — re-plugged itself/)
    expect(v.pill?.cls).toBe('devind--warn')
  })

  it('gateway-health.recovered-with-fault: bus-off wins the tag and the alert; both lines show', () => {
    const v = viewOf(gatewayStatus(node0({ boff: true }), false, 'recovery'))
    expect(v.pill).toEqual({
      cls: 'devind--err',
      tip: 'Gateway reports a problem — click for details'
    })
    expect(v.health).toMatchObject({ text: 'Bus-off', tone: 'err' })
    expect(v.health?.note).toBeDefined()
    expect(v.recovery).toMatch(/^Recovered itself/)
    expect(v.alert?.head).toBe('The Gateway can’t reach your panels')
  })

  it('not responding: the link title, and the recovery line still shows', () => {
    const v = viewOf(gatewayStatus(undefined, true, 'watchdog'))
    expect(v.title).toBe('Not responding')
    expect(v.recovery).toBe('Recovered itself since it was plugged in — its watchdog restarted it.')
  })

  it('nothing while the link is down', () => {
    expect(gatewayView(gatewayStatus(node0(), false, 'recovery'), false)).toEqual({})
  })
})
