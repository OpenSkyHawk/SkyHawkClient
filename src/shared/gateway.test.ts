import { describe, expect, it } from 'vitest'
import {
  GATEWAY_NO_ANSWER_MS,
  GatewayWatch,
  gatewayFaultLabel,
  gatewayProblem,
  gatewayRow,
  gatewayRowEvents,
  type GatewayRow
} from './gateway'
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

const row = (over: Partial<NodeStatus> = {}): GatewayRow => gatewayRow(node0(over))

const short = (es: LogEventInput[]): string[] =>
  es.map((e) => `${e.name}: ${eventText(e)} [${e.severity}]`)

describe('gatewayProblem — worst first, from its own flags only', () => {
  it('is null when healthy, or before it reports', () => {
    expect(gatewayProblem(undefined)).toBeNull()
    expect(gatewayProblem({ notResponding: false })).toBeNull()
    expect(gatewayProblem({ notResponding: false, row: row() })).toBeNull()
  })

  it('not responding and bus-off are errors', () => {
    expect(gatewayProblem({ notResponding: true, row: row({ overheat: true }) })).toEqual({
      kind: 'not-responding',
      severity: 'error'
    })
    expect(
      gatewayProblem({ notResponding: false, row: row({ boff: true, overheat: true }) })
    ).toEqual({ kind: 'bus-off', severity: 'error' })
  })

  it('overheat > error-passive > fault code, all warnings', () => {
    const p = (over: Partial<NodeStatus>) =>
      gatewayProblem({ notResponding: false, row: row(over) })
    expect(p({ overheat: true, epvf: true, faultId: 9 })).toEqual({
      kind: 'overheat',
      severity: 'warn'
    })
    expect(p({ epvf: true, faultId: 9 })).toEqual({ kind: 'error-passive', severity: 'warn' })
    expect(p({ faultId: 9 })).toEqual({ kind: 'fault', severity: 'warn' })
    expect(p({ degraded: true })).toEqual({ kind: 'fault', severity: 'warn' })
  })

  it('applies no threshold: a hot die or high TEC without the flag is healthy', () => {
    expect(
      gatewayProblem({ notResponding: false, row: row({ dieTempC: 95, tec: 200 }) })
    ).toBeNull()
  })
})

describe('gatewayFaultLabel', () => {
  it('uses the dictionary label, else the code, else Degraded', () => {
    expect(gatewayFaultLabel(row({ faultId: 9, faultLabel: 'Duplicate NODE_ID' }))).toBe(
      'Duplicate NODE_ID'
    )
    expect(gatewayFaultLabel(row({ faultId: 0x2a }))).toBe('Fault 42')
    expect(gatewayFaultLabel(row({ degraded: true }))).toBe('Degraded')
  })
})

describe('gatewayRowEvents', () => {
  it('a healthy first report makes no row; problems already there do', () => {
    expect(gatewayRowEvents(undefined, row(), 'r', 1)).toEqual([])
    expect(
      short(gatewayRowEvents(undefined, row({ overheat: true, dieTempC: 78 }), 'r', 1))
    ).toEqual(['Gateway: overheat · 78 °C [warn]'])
  })

  it('raised and cleared, like the node rows', () => {
    const a = row()
    const b = row({
      boff: true,
      epvf: true,
      tec: 131,
      degraded: true,
      faultId: 9,
      faultLabel: 'Duplicate NODE_ID'
    })
    expect(short(gatewayRowEvents(a, b, 'r', 1))).toEqual([
      'Gateway: bus-off [error]',
      'Gateway: error-passive · TEC 131 [warn]',
      'Gateway: degraded · Duplicate NODE_ID [warn]'
    ])
    expect(short(gatewayRowEvents(b, a, 'r', 2))).toEqual([
      'Gateway: bus-off cleared [info]',
      'Gateway: error-passive cleared [info]',
      'Gateway: degraded cleared [info]'
    ])
  })

  it('a different fault code is a new row', () => {
    expect(short(gatewayRowEvents(row({ faultId: 5 }), row({ faultId: 9 }), 'r', 1))).toEqual([
      'Gateway: degraded · Fault 9 [warn]'
    ])
  })

  it('keeps the source line as raw', () => {
    const [e] = gatewayRowEvents(undefined, row({ boff: true }), '_NODE_STATUS 00…', 7)
    expect(e).toMatchObject({ t: 7, source: 'client', name: 'Gateway', raw: '_NODE_STATUS 00…' })
  })
})

describe('GatewayWatch — not responding', () => {
  it('fires once a request goes unanswered for the full window', () => {
    const w = new GatewayWatch()
    w.takeChanged()
    w.asked(1000)
    expect(w.tick(1000 + GATEWAY_NO_ANSWER_MS - 1)).toEqual([])
    expect(w.health().notResponding).toBe(false)
    const out = w.tick(1000 + GATEWAY_NO_ANSWER_MS)
    expect(short(out)).toEqual(['Gateway: not responding · no answer for 5 s [error]'])
    expect(w.health().notResponding).toBe(true)
    expect(w.takeChanged()).toBe(true)
    // Said once, not on every tick.
    expect(w.tick(1000 + GATEWAY_NO_ANSWER_MS + 200)).toEqual([])
    expect(w.takeChanged()).toBe(false)
  })

  it('counts from the oldest unanswered request — a later poll does not restart it', () => {
    const w = new GatewayWatch()
    w.asked(0)
    w.asked(GATEWAY_NO_ANSWER_MS - 1)
    expect(w.tick(GATEWAY_NO_ANSWER_MS)).toHaveLength(1)
  })

  it('any answer resets the clock; after not responding it logs "responding again"', () => {
    const w = new GatewayWatch()
    w.asked(0)
    expect(w.answered('_NODE_STATUS_END', 10)).toEqual([])
    expect(w.tick(GATEWAY_NO_ANSWER_MS + 10)).toEqual([])
    w.asked(20_000)
    w.tick(20_000 + GATEWAY_NO_ANSWER_MS)
    expect(short(w.answered('_NODE_STATUS_END', 26_000))).toEqual([
      'Gateway: responding again [info]'
    ])
    expect(w.health().notResponding).toBe(false)
  })

  it('a calibration exchange pauses the clock but never ends "not responding"', () => {
    const w = new GatewayWatch()
    w.asked(0)
    expect(w.tick(GATEWAY_NO_ANSWER_MS, true)).toEqual([])
    expect(w.tick(GATEWAY_NO_ANSWER_MS * 2)).toEqual([]) // nothing pending after the pause
    w.asked(20_000)
    w.tick(20_000 + GATEWAY_NO_ANSWER_MS)
    w.tick(30_000, true)
    expect(w.health().notResponding).toBe(true)
  })

  it('reset (port open / close) starts over', () => {
    const w = new GatewayWatch()
    w.asked(0)
    w.tick(GATEWAY_NO_ANSWER_MS)
    w.report(node0({ overheat: true }), 'r', 1)
    w.reset()
    expect(w.health()).toEqual({ notResponding: false })
    expect(w.tick(60_000)).toEqual([])
  })
})

describe('GatewayWatch — its own row', () => {
  it('pushes only when what it reports changes (not uptime or rxCount)', () => {
    const w = new GatewayWatch()
    w.takeChanged()
    expect(w.report(node0(), 'r', 1)).toEqual([])
    expect(w.takeChanged()).toBe(true)
    expect(w.health().row).toMatchObject({ dieTempC: 42, boff: false })
    w.report(node0({ uptimeSec: 999, rxCount: 77 }), 'r', 2)
    expect(w.takeChanged()).toBe(false)
    w.report(node0({ dieTempC: 43 }), 'r', 3)
    expect(w.takeChanged()).toBe(true)
  })

  it('logs flags raised and cleared', () => {
    const w = new GatewayWatch()
    w.report(node0(), 'r', 1)
    expect(short(w.report(node0({ boff: true }), 'r', 2))).toEqual(['Gateway: bus-off [error]'])
    expect(short(w.report(node0(), 'r', 3))).toEqual(['Gateway: bus-off cleared [info]'])
  })
})
