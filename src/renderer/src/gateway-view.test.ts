import { describe, expect, it } from 'vitest'
import type { GatewayHealth, GatewayRow } from '@shared/gateway'
import { gatewayView } from './gateway-view'

const PORT = '/dev/cu.usbmodem1101'

const row = (over: Partial<GatewayRow> = {}): GatewayRow => ({
  boff: false,
  epvf: false,
  tec: 0,
  rec: 0,
  dieTempC: 42,
  overheat: false,
  degraded: false,
  faultId: 0,
  ...over
})

const h = (over: Partial<GatewayRow> = {}, notResponding = false): GatewayHealth => ({
  notResponding,
  row: row(over)
})

describe('gatewayView — nothing to show', () => {
  it('while the link is down, whatever it last reported', () => {
    expect(gatewayView(h({ boff: true }), false, PORT)).toEqual({})
    expect(gatewayView(undefined, true, PORT)).toEqual({})
  })

  it('before its first report (or firmware before v3): no Health row', () => {
    expect(gatewayView({ notResponding: false }, true, PORT)).toEqual({})
  })

  it('healthy: the Health row only — no pill change, alert or Attention item', () => {
    expect(gatewayView(h(), true, PORT)).toEqual({ health: { text: 'OK · 42 °C' } })
    expect(gatewayView(h({ dieTempC: null }), true).health).toEqual({ text: 'OK' })
  })
})

describe('gatewayView — still works, reports a problem (gold !)', () => {
  it('overheat', () => {
    const v = gatewayView(h({ overheat: true, dieTempC: 78 }), true, PORT)
    expect(v.pill).toEqual({
      cls: 'devind--warn',
      tip: `Gateway reports a problem · ${PORT} — click for details`
    })
    expect(v.health).toMatchObject({ text: 'Overheat · 78 °C', tone: 'warn' })
    expect(v.health?.note).toMatch(/temperature trip/)
    expect(v.attention).toEqual({ flag: 'Overheat · 78 °C', state: 'warn' })
    expect(v.alert).toBeUndefined()
  })

  it('error-passive, with its TEC', () => {
    const v = gatewayView(h({ epvf: true, tec: 131 }), true, PORT)
    expect(v.pill?.cls).toBe('devind--warn')
    expect(v.health).toMatchObject({ text: 'Error-passive', tone: 'warn' })
    expect(v.health?.note).toMatch(/TEC 131/)
    expect(v.alert).toBeUndefined()
  })

  it('duplicate NODE_ID, in client words', () => {
    const v = gatewayView(h({ degraded: true, faultId: 9, faultLabel: 'Duplicate NODE_ID' }), true)
    expect(v.health).toMatchObject({ text: 'Duplicate NODE_ID', tone: 'warn' })
    expect(v.health?.note).toMatch(/uses NODE_ID 0, the Gateway’s own/)
    expect(v.attention).toEqual({ flag: 'Duplicate NODE_ID', state: 'warn' })
  })

  it('a fault code it has no words for: the label, no note', () => {
    const v = gatewayView(h({ degraded: true, faultId: 1, faultLabel: 'I2C peripheral' }), true)
    expect(v.health).toEqual({ text: 'I2C peripheral', tone: 'warn', note: undefined })
  })

  it('shows the worst one only', () => {
    const v = gatewayView(h({ overheat: true, epvf: true, faultId: 9 }), true)
    expect(v.health?.text).toBe('Overheat · 42 °C')
  })

  it('no port known: the tooltip still reads', () => {
    expect(gatewayView(h({ overheat: true }), true).pill?.tip).toBe(
      'Gateway reports a problem — click for details'
    )
  })
})

describe('gatewayView — panel input can’t reach DCS (red !)', () => {
  it('bus-off: red pill, Health row, Overview alert, Attention item', () => {
    const v = gatewayView(h({ boff: true, overheat: true }), true, PORT)
    expect(v.pill?.cls).toBe('devind--err')
    expect(v.health).toMatchObject({ text: 'Bus-off', tone: 'err' })
    expect(v.alert?.head).toBe('The Gateway can’t reach your panels')
    expect(v.alert?.text).toMatch(/^its cockpit \(CAN\) side went bus-off/)
    expect(v.attention).toEqual({ flag: 'Bus-off', state: 'off' })
  })

  it('not responding: a link state — popover title and line, no Health row', () => {
    const v = gatewayView(h({ overheat: true }, true), true, PORT)
    expect(v.pill?.cls).toBe('devind--err')
    expect(v.title).toBe('Not responding')
    expect(v.meta).toBe(
      'No answer for 5 s while the port is open. Unplug its USB cable and plug it back in.'
    )
    expect(v.health).toBeUndefined()
    expect(v.alert?.head).toBe('Gateway not responding')
    expect(v.attention).toEqual({ flag: 'Not responding', state: 'off' })
  })

  it('not responding before it ever reported', () => {
    expect(gatewayView({ notResponding: true }, true).title).toBe('Not responding')
  })
})
