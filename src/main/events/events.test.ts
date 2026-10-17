import { describe, expect, it } from 'vitest'
import { clientErrorEvent, EventLog, EVENTS_TSV_HEADER, eventsToTsv } from './event-log'
import { EventJournal } from './event-journal'
import { relayEvents } from '../dcs/relay-events'
import { deviceEvent } from '../gateway/link-events'
import { NodeEventTracker, type NodeLookup } from '../nodes/node-events'
import type { LogEventInput } from '@shared/events'
import { eventText } from '@shared/format'
import { NODE_END_MSG, NODE_MSG, ROSTER_REPLY_MS } from '../nodes/node-status-wire'
import type { NodeStatus, NodeTelem } from '@shared/nodes'
import { PDU_RAIL_FLAGS as RAIL_FLAG, PDU_STATUS_FLAGS as PDU_FLAG } from '@shared/firmware'
import { nodeStatus } from '../../test-fixtures/nodes'

const st = (nodeId: number, over: Partial<NodeStatus> = {}): NodeStatus =>
  nodeStatus(nodeId, { uptimeSec: 0, rxCount: 0, dieTempC: null, ...over })

const NAMES: Record<number, string> = { 2: 'Right_Navigation', 4: 'PDU_Right', 7: 'Left_Fuel' }
const lookup = (): NodeLookup => ({
  name: (id) => NAMES[id] ?? `Node ${id}`,
  isNew: (id) => !(id in NAMES),
  unmapped: (id) => !(id in NAMES)
})

/** Short form for assertions: `name: event · detail [severity]`. */
const short = (es: LogEventInput[]): string[] =>
  es.map((e) => `${e.name}: ${eventText(e)} [${e.severity}]`)

/** A tracker past its baseline, with `nodes` online. */
function live(nodes: NodeStatus[]): NodeEventTracker {
  const t = new NodeEventTracker(lookup())
  t.status(nodes, NODE_MSG, '', 0)
  t.status(nodes, NODE_END_MSG, '_NODE_STATUS_END', 10)
  return t
}

describe('NodeEventTracker — baseline', () => {
  it('summarises the first roster as one row, raw = the END line', () => {
    const t = new NodeEventTracker(lookup())
    expect(t.status([st(2)], NODE_MSG, 'a', 0)).toEqual([])
    const out = t.status([st(2), st(7)], NODE_END_MSG, '_NODE_STATUS_END', 5)
    expect(short(out)).toEqual(['roster: 2 nodes online [info]'])
    expect(out[0].raw).toBe('_NODE_STATUS_END')
    expect(out[0].nodeId).toBeUndefined()
  })

  it('still reports problems present at baseline', () => {
    const t = new NodeEventTracker(lookup())
    const out = t.status([st(2, { boff: true }), st(7, { present: false })], NODE_MSG, 'line', 0)
    expect(short(out)).toEqual([
      'Right_Navigation: bus-off [error]',
      'Left_Fuel: offline · no heartbeat [error]'
    ])
    expect(out.every((e) => e.raw === 'line')).toBe(true)
  })

  it('closes the baseline once the reply window passes without an END', () => {
    const t = new NodeEventTracker(lookup())
    t.status([st(2)], NODE_MSG, '', 0)
    const out = t.status([st(2), st(7)], NODE_MSG, 'late', ROSTER_REPLY_MS + 1)
    expect(short(out)).toEqual(['roster: 1 node online [info]', 'Left_Fuel: online [info]'])
  })

  it('starts a new baseline after reset (port reopen)', () => {
    const t = live([st(2)])
    t.reset()
    expect(t.status([st(2)], NODE_MSG, '', 100)).toEqual([])
    expect(short(t.status([st(2)], NODE_END_MSG, '', 101))).toEqual([
      'roster: 1 node online [info]'
    ])
  })
})

describe('NodeEventTracker — changes', () => {
  it('is silent when a poll repeats what is known', () => {
    const t = live([st(2), st(7)])
    expect(t.status([st(2), st(7)], NODE_MSG, '', 20)).toEqual([])
    expect(t.status([st(2), st(7)], NODE_END_MSG, '', 21)).toEqual([])
  })

  it('offline by delta vs by roster end, then back online', () => {
    const t = live([st(2), st(7)])
    expect(short(t.status([st(2), st(7, { present: false })], NODE_MSG, 'd', 20))).toEqual([
      'Left_Fuel: offline · no heartbeat [error]'
    ])
    expect(
      short(t.status([st(2, { present: false }), st(7, { present: false })], NODE_END_MSG, 'e', 30))
    ).toEqual(['Right_Navigation: offline · missing from roster [error]'])
    expect(short(t.status([st(2), st(7, { present: false })], NODE_MSG, 'f', 40))).toEqual([
      'Right_Navigation: online [info]'
    ])
  })

  it('raises and clears bus-off, error-passive (with TEC), overheat', () => {
    const t = live([st(2)])
    expect(
      short(
        t.status([st(2, { boff: true, epvf: true, tec: 131, overheat: true })], NODE_MSG, '', 20)
      )
    ).toEqual([
      'Right_Navigation: bus-off [error]',
      'Right_Navigation: error-passive · TEC 131 [warn]',
      'Right_Navigation: overheat [warn]'
    ])
    expect(short(t.status([st(2)], NODE_MSG, '', 30))).toEqual([
      'Right_Navigation: bus-off cleared [info]',
      'Right_Navigation: error-passive cleared [info]',
      'Right_Navigation: overheat cleared [info]'
    ])
  })

  it('degraded carries the fault label (or Fault N), and a new fault id is a new row', () => {
    const t = live([st(2)])
    const deg = (faultId: number, faultLabel?: string) =>
      st(2, { degraded: true, faultId, faultLabel })
    expect(short(t.status([deg(2, 'I2C peripheral')], NODE_MSG, '', 20))).toEqual([
      'Right_Navigation: degraded · I2C peripheral [warn]'
    ])
    expect(short(t.status([deg(9)], NODE_MSG, '', 30))).toEqual([
      'Right_Navigation: degraded · Fault 9 [warn]'
    ])
    expect(short(t.status([st(2)], NODE_MSG, '', 40))).toEqual([
      'Right_Navigation: degraded cleared [info]'
    ])
  })

  it('does not clear flags when a node goes offline, and re-raises them when it comes back', () => {
    const t = live([st(2, { boff: true })])
    expect(short(t.status([st(2, { present: false })], NODE_MSG, '', 20))).toEqual([
      'Right_Navigation: offline · no heartbeat [error]'
    ])
    expect(short(t.status([st(2, { boff: true })], NODE_MSG, '', 30))).toEqual([
      'Right_Navigation: online [info]',
      'Right_Navigation: bus-off [error]'
    ])
  })

  it('a registry board not added yet is new too, and says it is in NODE_IDS.md (#93)', () => {
    const t = new NodeEventTracker({ ...lookup(), inRegistry: (id) => id === 41 })
    t.status([st(2)], NODE_MSG, '', 0)
    t.status([st(2)], NODE_END_MSG, '_NODE_STATUS_END', 10)
    expect(short(t.status([st(2), st(41)], NODE_MSG, '', 20))).toEqual([
      'Node 41: new on the bus · in NODE_IDS.md [new]'
    ])
  })

  it('reports a new node once per app run, even across a reopen', () => {
    const t = live([st(2)])
    expect(short(t.status([st(2), st(41)], NODE_MSG, '', 20))).toEqual([
      'Node 41: new on the bus · not in registry [new]'
    ])
    t.reset()
    t.status([st(41)], NODE_MSG, '', 30)
    expect(short(t.status([st(41)], NODE_END_MSG, '', 31))).toEqual([
      'roster: 1 node online [info]'
    ])
  })

  it('a new node coming back in a later port session gets an online row (review of #86)', () => {
    const t = live([st(2)])
    t.status([st(2), st(41)], NODE_MSG, '', 20) // "new on the bus"
    t.reset() // port reopens with 41 unplugged
    t.status([st(2)], NODE_MSG, '', 30)
    expect(short(t.status([st(2)], NODE_END_MSG, '', 31))).toEqual(['roster: 1 node online [info]'])
    expect(short(t.status([st(2), st(41)], NODE_MSG, '', 40))).toEqual(['Node 41: online [info]'])
    expect(short(t.status([st(2), st(41, { present: false })], NODE_MSG, '', 50))).toEqual([
      'Node 41: offline · no heartbeat [error]'
    ])
  })

  it('a new node seen at baseline still gets its row', () => {
    const t = new NodeEventTracker(lookup())
    expect(short(t.status([st(41)], NODE_MSG, '', 0))).toEqual([
      'Node 41: new on the bus · not in registry [new]'
    ])
  })
})

describe('NodeEventTracker — PDU telemetry', () => {
  const rail = (page: 1 | 2, flags: number, vMinMv = 4710): NodeTelem => ({
    nodeId: 4,
    kind: 'rail',
    page,
    flags,
    vAvgMv: 4900,
    vMinMv,
    iAvgMa: 1500
  })
  const status = (flags: number, ntcTempC: number | null = 61.25): NodeTelem => ({
    nodeId: 4,
    kind: 'status',
    page: 3,
    flags,
    ntcTempC,
    i12PeakMa: 0,
    i5PeakMa: 0
  })

  it('a healthy first page is silent; a raised flag shows its reading', () => {
    const t = new NodeEventTracker(lookup())
    expect(t.telemetry(rail(2, 0), 'r', 0)).toEqual([])
    const out = t.telemetry(rail(2, RAIL_FLAG.UNDER_V), '_NODE_TELEM 0402010000', 1)
    expect(short(out)).toEqual(['PDU_Right: 5V UNDER-V raised · 4.71 V [warn]'])
    expect(out[0]).toMatchObject({ nodeId: 4, source: 'node', raw: '_NODE_TELEM 0402010000' })
  })

  it('repeats nothing; clears per bit; rails are tracked separately', () => {
    const t = new NodeEventTracker(lookup())
    t.telemetry(rail(1, RAIL_FLAG.UNDER_V | RAIL_FLAG.OVER_CURRENT, 11380), '', 0)
    expect(t.telemetry(rail(1, RAIL_FLAG.UNDER_V | RAIL_FLAG.OVER_CURRENT), '', 1)).toEqual([])
    expect(short(t.telemetry(rail(1, RAIL_FLAG.OVER_CURRENT), '', 2))).toEqual([
      'PDU_Right: 12V UNDER-V cleared [info]'
    ])
    expect(short(t.telemetry(rail(2, RAIL_FLAG.FUSE_OPEN), '', 3))).toEqual([
      'PDU_Right: 5V FUSE OPEN raised · 4.90 V [warn]'
    ])
  })

  it('first page with flags already up raises them (over-current shows amps)', () => {
    const t = new NodeEventTracker(lookup())
    expect(short(t.telemetry(rail(1, RAIL_FLAG.OVER_CURRENT), '', 0))).toEqual([
      'PDU_Right: 12V OVER-I raised · 1.50 A [warn]'
    ])
  })

  it('status page: temperature flags carry the NTC reading, UNCAL is info', () => {
    const t = new NodeEventTracker(lookup())
    expect(short(t.telemetry(status(PDU_FLAG.TEMP_WARN | PDU_FLAG.UNCAL_ZERO), '', 0))).toEqual([
      'PDU_Right: TEMP WARN raised · 61.3 °C [warn]',
      'PDU_Right: UNCAL ZERO raised [info]'
    ])
    expect(short(t.telemetry(status(PDU_FLAG.NTC_FAULT, null), '', 1))).toEqual([
      'PDU_Right: TEMP WARN cleared [info]',
      'PDU_Right: NTC FAULT raised [warn]',
      'PDU_Right: UNCAL ZERO cleared [info]'
    ])
  })

  it('reset forgets the flags; unknown pages are skipped', () => {
    const u = new NodeEventTracker(lookup())
    expect(u.telemetry({ nodeId: 4, kind: 'unknown', page: 9, body: '00' }, '', 0)).toEqual([])
    u.telemetry(rail(2, RAIL_FLAG.UNDER_V), '', 0)
    u.reset()
    expect(u.telemetry(rail(2, RAIL_FLAG.UNDER_V), '', 1)).toHaveLength(1)
  })
})

describe('client events', () => {
  it('serial / DCS errors keep the original message', () => {
    expect(clientErrorEvent('SERIAL', 'write EIO', 5)).toEqual({
      t: 5,
      source: 'client',
      name: 'SERIAL',
      severity: 'error',
      event: 'serial port error',
      detail: 'write EIO',
      raw: 'SERIAL Error: write EIO'
    })
    expect(eventText(clientErrorEvent('DCS', 'connect ECONNREFUSED', 0))).toBe(
      'link error · connect ECONNREFUSED'
    )
  })

  it('a warn row (recovered, nothing lost) is the same row apart from its severity', () => {
    expect(clientErrorEvent('config.json', 'loaded the backup', 5, 'warn')).toEqual({
      ...clientErrorEvent('config.json', 'loaded the backup', 5),
      severity: 'warn'
    })
  })

  it('EventJournal: warn and error rows share one dedupe per tag', () => {
    const logged: string[] = []
    const j = new EventJournal(
      () => {},
      (tag) => logged.push(tag)
    )
    j.warn('config.json', 'a')
    j.warn('config.json', 'a') // a repeat: no row
    j.error('config.json', 'a') // the same message at error: still a repeat
    j.error('config.json', 'b')
    j.forget('config.json')
    j.warn('config.json', 'b') // forgotten: news again
    expect(j.snapshot().map((e) => `${e.severity}:${e.detail}`)).toEqual([
      'warn:a',
      'error:b',
      'warn:b'
    ])
    expect(logged).toEqual([
      'warn.config.json',
      'warn.config.json',
      'error.config.json',
      'error.config.json',
      'warn.config.json'
    ])
  })

  it('device: one row per reported state; scanning and resting no-device are skipped', () => {
    const p = '/dev/cu.usbmodem1101'
    expect(deviceEvent(undefined, { state: 'scanning' }, 0)).toBeNull()
    expect(deviceEvent(undefined, { state: 'no-device' }, 0)).toBeNull()
    expect(deviceEvent('disconnected', { state: 'no-device' }, 0)).toBeNull()
    const up = deviceEvent('no-device', { state: 'connected', portPath: p }, 0)!
    expect(short([up])).toEqual([`Gateway: connected · ${p} [info]`])
    expect(up.raw).toBe(`device: connected ${p}`)
    expect(deviceEvent('connected', { state: 'connected', portPath: p }, 0)).toBeNull()
    expect(short([deviceEvent('connected', { state: 'reconnecting' }, 0)!])).toEqual([
      'Gateway: reconnecting · link dropped [warn]'
    ])
    expect(short([deviceEvent('reconnecting', { state: 'no-device' }, 0)!])).toEqual([
      'Gateway: no device · unplugged [warn]'
    ])
    // A port that will not open is already the SERIAL error row; recovering from it is news.
    expect(deviceEvent('no-device', { state: 'error', detail: 'port busy' }, 0)).toBeNull()
    expect(short([deviceEvent('error', { state: 'connected', portPath: p }, 0)!])).toEqual([
      `Gateway: connected · ${p} [info]`
    ])
    expect(short([deviceEvent('connected', { state: 'disconnected' }, 0)!])).toEqual([
      'Gateway: disconnected [info]'
    ])
  })

  it('relay: started / stopped, DCS link up / reconnecting; errors are left to the DCS row', () => {
    const ctx = { mode: 'bridge' as const, endpoint: '127.0.0.1:7778', tcp: true }
    const stopped = { running: false }
    const connecting = { running: true, stream: 'connecting' as const }
    expect(short(relayEvents(stopped, connecting, ctx, 0))).toEqual([
      'Relay: started · Bridge mode [info]'
    ])
    expect(short(relayEvents(connecting, { running: true, stream: 'connected' }, ctx, 0))).toEqual([
      'DCS: link up · 127.0.0.1:7778 [info]'
    ])
    expect(
      short(
        relayEvents(
          { running: true, stream: 'connected' },
          { running: true, stream: 'reconnecting' },
          ctx,
          0
        )
      )
    ).toEqual(['DCS: reconnecting · 127.0.0.1:7778 [warn]'])
    expect(
      relayEvents(connecting, { running: true, stream: 'error', detail: 'x' }, ctx, 0)
    ).toEqual([])
    // A refused connection retrying: error ↔ reconnecting every 2 s makes no rows.
    const err = { running: true, stream: 'error' as const, detail: 'x' }
    expect(relayEvents(err, { running: true, stream: 'reconnecting' }, ctx, 0)).toEqual([])
    expect(short(relayEvents(connecting, stopped, ctx, 0))).toEqual(['Relay: stopped [info]'])
    // UDP binds at once: start and "listening" in one transition.
    const udp = { ...ctx, tcp: false, endpoint: '239.255.50.10:5010' }
    expect(short(relayEvents(stopped, { running: true, stream: 'connected' }, udp, 0))).toEqual([
      'Relay: started · Bridge mode [info]',
      'DCS: listening · 239.255.50.10:5010 [info]'
    ])
  })

  it('relay in replay: only start, ended, stop', () => {
    const ctx = { mode: 'replay' as const, endpoint: '', tcp: false }
    expect(
      short(relayEvents({ running: false }, { running: true, stream: 'connected' }, ctx, 0))
    ).toEqual(['Relay: started · Replay [info]'])
    expect(
      short(
        relayEvents(
          { running: true, stream: 'connected' },
          { running: true, stream: 'ended' },
          ctx,
          0
        )
      )
    ).toEqual(['Relay: replay ended [info]'])
  })
})

describe('EventLog', () => {
  const e = (event: string): LogEventInput => ({
    t: 0,
    source: 'client',
    name: 'Relay',
    severity: 'info',
    event,
    raw: ''
  })

  it('assigns increasing ids that survive Clear, and hands out each row once', () => {
    const log = new EventLog()
    log.add([e('a'), e('b')])
    expect(log.take().map((x) => x.id)).toEqual([1, 2])
    expect(log.take()).toEqual([])
    log.clear()
    log.add([e('c')])
    expect(log.snapshot().map((x) => [x.id, x.event])).toEqual([[3, 'c']])
  })

  it('drops the oldest rows past its cap', () => {
    const log = new EventLog(2)
    log.add([e('a'), e('b'), e('c')])
    expect(log.snapshot().map((x) => x.event)).toEqual(['b', 'c'])
    expect(log.take().map((x) => x.event)).toEqual(['b', 'c'])
  })

  it('clear also drops what was not pushed yet', () => {
    const log = new EventLog()
    log.add([e('a')])
    log.clear()
    expect(log.take()).toEqual([])
  })
})

describe('eventsToTsv', () => {
  it('writes every row oldest first with the fixed columns; tabs in fields become spaces', () => {
    const t = new Date(2026, 9, 16, 21, 14, 7, 412).getTime()
    const tsv = eventsToTsv([
      {
        id: 2,
        t,
        source: 'client',
        name: 'SERIAL',
        severity: 'error',
        event: 'serial port error',
        detail: 'a\tb',
        raw: 'SERIAL Error: a\tb'
      },
      {
        id: 1,
        t,
        source: 'node',
        nodeId: 4,
        name: 'PDU_Right',
        severity: 'warn',
        event: '5V UNDER-V raised',
        detail: '4.71 V',
        raw: '_NODE_TELEM x'
      }
    ])
    expect(tsv.split('\n')).toEqual([
      EVENTS_TSV_HEADER,
      '2026-10-16 21:14:07.412\tnode\t4\tPDU_Right\twarn\t5V UNDER-V raised\t4.71 V\t_NODE_TELEM x',
      '2026-10-16 21:14:07.412\tclient\t\tSERIAL\terror\tserial port error\ta b\tSERIAL Error: a b',
      ''
    ])
  })
})
