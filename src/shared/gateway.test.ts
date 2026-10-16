import { describe, expect, it } from 'vitest'
import { GATEWAY_NO_ANSWER_MS, GatewayWatch, gatewayEvents, gatewayStatus } from './gateway'
import { eventText, type LogEventInput } from './events'
import type { NodeStatus } from './nodes'

const node0 = (over: Partial<NodeStatus> = {}): NodeStatus => ({
  nodeId: 0,
  present: true,
  boff: false,
  epvf: false,
  uptimeSec: 100,
  rxCount: 5,
  tec: 0,
  rec: 0,
  dieTempC: 42,
  overheat: false,
  degraded: false,
  faultId: 0,
  nodeKind: 3,
  ...over
})

const st = (over: Partial<NodeStatus> = {}, notResponding = false) =>
  gatewayStatus(node0(over), notResponding)! // a row always has a status

const short = (es: LogEventInput[]): string[] =>
  es.map((e) => `${e.name}: ${eventText(e)} [${e.severity}]`)

describe('gatewayStatus — the one place the Gateway’s health is decided', () => {
  it('nothing to say before it reports and while it answers', () => {
    expect(gatewayStatus(undefined, false)).toBeUndefined()
  })

  it('healthy, with its die temperature when it has one', () => {
    expect(st()).toEqual({ severity: 'ok', kind: 'ok', label: 'OK · 42 °C' })
    expect(st({ dieTempC: null }).label).toBe('OK')
  })

  it('applies no threshold: a hot die or high TEC without the flag is healthy', () => {
    expect(st({ dieTempC: 95, tec: 200 }).severity).toBe('ok')
  })

  it('warnings: overheat, error-passive, a fault code — each with its note', () => {
    expect(st({ overheat: true, dieTempC: 78 })).toMatchObject({
      severity: 'warn',
      kind: 'overheat',
      label: 'Overheat · 78 °C',
      note: 'The Gateway raised its own temperature trip. Check the airflow around it.'
    })
    expect(st({ epvf: true, tec: 131 })).toMatchObject({
      severity: 'warn',
      kind: 'error-passive',
      label: 'Error-passive'
    })
    expect(st({ epvf: true, tec: 131 }).note).toMatch(/TEC 131/)
    const dup = st({ degraded: true, faultId: 9, faultLabel: 'Duplicate NODE_ID' })
    expect(dup).toMatchObject({ severity: 'warn', kind: 'fault', label: 'Duplicate NODE_ID' })
    expect(dup.note).toMatch(/uses NODE_ID 0, the Gateway’s own/)
  })

  it('a fault code it has no words for: the dictionary label, else the code; no note', () => {
    expect(st({ degraded: true, faultId: 1, faultLabel: 'I2C peripheral' })).toEqual({
      severity: 'warn',
      kind: 'fault',
      label: 'I2C peripheral',
      note: undefined
    })
    expect(st({ faultId: 0x2a }).label).toBe('Fault 42')
  })

  it('errors carry the Overview alert; warnings never do', () => {
    const b = st({ boff: true })
    expect(b).toMatchObject({ severity: 'err', kind: 'bus-off', label: 'Bus-off' })
    expect(b.alert?.head).toBe('The Gateway can’t reach your panels')
    expect(st({ overheat: true }).alert).toBeUndefined()
    const nr = gatewayStatus(undefined, true)!
    expect(nr).toMatchObject({ severity: 'err', kind: 'not-responding', label: 'Not responding' })
    expect(nr.note).toBe(
      'No answer for 5 s while the port is open. Unplug its USB cable and plug it back in.'
    )
    expect(nr.alert?.head).toBe('Gateway not responding')
  })

  it('worst only: not responding > bus-off > overheat > error-passive > fault code', () => {
    const all = { boff: true, overheat: true, epvf: true, faultId: 9 }
    expect(st(all, true).kind).toBe('not-responding')
    expect(st(all).kind).toBe('bus-off')
    expect(st({ ...all, boff: false }).kind).toBe('overheat')
    expect(st({ epvf: true, faultId: 9 }).kind).toBe('error-passive')
  })
})

describe('gatewayEvents — rows read the status', () => {
  const ev = (prev: Partial<NodeStatus> | null, next: Partial<NodeStatus> | null) =>
    short(
      gatewayEvents(
        prev ? st(prev) : undefined,
        next ? st(next) : undefined,
        next ? node0(next) : undefined,
        'r',
        1
      )
    )

  it('a healthy first report makes no row; a problem already there does', () => {
    expect(ev(null, {})).toEqual([])
    expect(ev(null, { overheat: true })).toEqual(['Gateway: overheat [warn]'])
  })

  it('raised and cleared, in the node rows’ words', () => {
    expect(ev({}, { boff: true })).toEqual(['Gateway: bus-off [error]'])
    expect(ev({ boff: true }, {})).toEqual(['Gateway: bus-off cleared [info]'])
    expect(ev({}, { epvf: true, tec: 131 })).toEqual(['Gateway: error-passive · TEC 131 [warn]'])
    expect(ev({}, { faultId: 9, faultLabel: 'Duplicate NODE_ID' })).toEqual([
      'Gateway: degraded · Duplicate NODE_ID [warn]'
    ])
  })

  it('a temperature change is not news; a new fault code is', () => {
    expect(ev({ overheat: true, dieTempC: 78 }, { overheat: true, dieTempC: 80 })).toEqual([])
    expect(ev({ faultId: 5 }, { faultId: 9 })).toEqual(['Gateway: degraded · Fault 9 [warn]'])
  })

  it('a worse problem takes over silently; a milder one says the worse one cleared', () => {
    expect(ev({ overheat: true }, { overheat: true, boff: true })).toEqual([
      'Gateway: bus-off [error]'
    ])
    expect(ev({ overheat: true, boff: true }, { overheat: true })).toEqual([
      'Gateway: bus-off cleared [info]',
      'Gateway: overheat [warn]'
    ])
  })
})

describe('GatewayWatch — not responding', () => {
  /** A watch whose Gateway has answered once since the port opened. */
  const armed = (): GatewayWatch => {
    const w = new GatewayWatch()
    w.answered('_NODE_STATUS_END', 0)
    return w
  }

  it('never fires for a Gateway that has not answered since the port opened', () => {
    const w = new GatewayWatch() // e.g. built without node status
    w.asked(0)
    expect(w.tick(GATEWAY_NO_ANSWER_MS * 10)).toEqual([])
    expect(w.status()).toBeUndefined()
  })

  it('fires once a request goes unanswered for the full window', () => {
    const w = armed()
    w.takeChanged()
    w.asked(1000)
    expect(w.tick(1000 + GATEWAY_NO_ANSWER_MS - 1)).toEqual([])
    expect(w.status()).toBeUndefined()
    const out = w.tick(1000 + GATEWAY_NO_ANSWER_MS)
    expect(short(out)).toEqual(['Gateway: not responding · no answer for 5 s [error]'])
    expect(w.status()?.kind).toBe('not-responding')
    expect(w.takeChanged()).toBe(true)
    // Said once, not on every tick.
    expect(w.tick(1000 + GATEWAY_NO_ANSWER_MS + 200)).toEqual([])
    expect(w.takeChanged()).toBe(false)
  })

  it('counts from the oldest unanswered request — a later poll does not restart it', () => {
    const w = armed()
    w.asked(0)
    w.asked(GATEWAY_NO_ANSWER_MS - 1)
    expect(w.tick(GATEWAY_NO_ANSWER_MS)).toHaveLength(1)
  })

  it('any answer resets the clock; after not responding it logs "responding again"', () => {
    const w = armed()
    w.asked(0)
    expect(w.answered('_NODE_STATUS_END', 10)).toEqual([])
    expect(w.tick(GATEWAY_NO_ANSWER_MS + 10)).toEqual([])
    w.asked(20_000)
    w.tick(20_000 + GATEWAY_NO_ANSWER_MS)
    expect(short(w.answered('_NODE_STATUS_END', 26_000))).toEqual([
      'Gateway: responding again [info]'
    ])
    expect(w.status()).toBeUndefined()
  })

  it('answering with a problem: responding again, then the problem', () => {
    const w = armed()
    w.asked(0)
    w.tick(GATEWAY_NO_ANSWER_MS)
    const out = [...w.answered('r', 6000), ...w.report(node0({ boff: true }), 'r', 6000)]
    expect(short(out)).toEqual(['Gateway: responding again [info]', 'Gateway: bus-off [error]'])
  })

  it('a calibration exchange pauses the clock but never ends "not responding"', () => {
    const w = armed()
    w.asked(0)
    expect(w.tick(GATEWAY_NO_ANSWER_MS, true)).toEqual([])
    expect(w.tick(GATEWAY_NO_ANSWER_MS * 2)).toEqual([]) // nothing pending after the pause
    w.asked(20_000)
    w.tick(20_000 + GATEWAY_NO_ANSWER_MS)
    w.tick(30_000, true)
    expect(w.status()?.kind).toBe('not-responding')
  })

  it('reset (port open / close) starts over', () => {
    const w = armed()
    w.asked(0)
    w.tick(GATEWAY_NO_ANSWER_MS)
    w.report(node0({ overheat: true }), 'r', 1)
    w.reset()
    expect(w.status()).toBeUndefined()
    w.asked(60_000) // not armed again until it answers on the new port
    expect(w.tick(70_000)).toEqual([])
  })
})

describe('GatewayWatch — its own row', () => {
  it('pushes only when the status changes (not uptime or rxCount)', () => {
    const w = new GatewayWatch()
    w.takeChanged()
    expect(w.report(node0(), 'r', 1)).toEqual([])
    expect(w.takeChanged()).toBe(true)
    expect(w.status()?.label).toBe('OK · 42 °C')
    w.report(node0({ uptimeSec: 999, rxCount: 77 }), 'r', 2)
    expect(w.takeChanged()).toBe(false)
    w.report(node0({ dieTempC: 43 }), 'r', 3)
    expect(w.takeChanged()).toBe(true)
  })

  it('logs problems raised and cleared, with the source line', () => {
    const w = new GatewayWatch()
    w.report(node0(), 'r', 1)
    const [e] = w.report(node0({ boff: true }), '_NODE_STATUS 0001…', 2)
    expect(e).toMatchObject({ t: 2, source: 'client', name: 'Gateway', raw: '_NODE_STATUS 0001…' })
    expect(short(w.report(node0(), 'r', 3))).toEqual(['Gateway: bus-off cleared [info]'])
  })
})
