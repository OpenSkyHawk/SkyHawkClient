// SESSION-seam tests for fix-track chunk 4's new boards and event log (#133: D1 / X3 / R2, S6,
// X8 / C6, D8 / S5 / C4), through the services harness: the Gateway's lines arrive on the fake
// serial port, and the test reads only pushes, intents and files.
import { describe, expect, it } from 'vitest'
import { CTRL } from '@shared/app'
import type { LogEvent } from '@shared/events'
import { eventText } from '@shared/format'
import type { CockpitSnapshot, NodeMappingFile } from '@shared/nodes'
import { statusLine } from '../../test-fixtures/nodes'
import { makeServices, type Services } from '../test-harness/services'

const PANEL = 0x01
const UNREPORTED = 0x00
/** Board 1 (Center_Armament) is in your cockpit. */
const COCKPIT = { 'node-mapping.json': { version: 4, nodes: { 1: { added: true } } } }
/** And PDU_Left (3). */
const WITH_PDU = {
  'node-mapping.json': { version: 4, nodes: { 1: { added: true }, 3: { added: true } } }
}

/** The Gateway's roster reply: its own row, then a row per board, then the END with the count. */
function reply(app: Services, boards: [id: number, kind: number][]): void {
  app.serial.receive(statusLine(0, true, 3))
  for (const [id, kind] of boards) app.serial.receive(statusLine(id, true, kind))
  app.serial.receive(`_NODE_STATUS_END ${boards.length + 1}\n`)
}

const snap = (app: Services): CockpitSnapshot => app.lastPush('cockpit:snapshot')!

/** What each tab says about a stray: the Cockpit, the Overview and Connection. */
function strayCounts(app: Services) {
  const s = snap(app)
  return {
    cockpit: [s.band.band.warn, s.attention.items.filter((i) => i.stray).map((i) => i.nodeId)],
    overview: [s.overview.tile.value, s.overview.banner?.detail ?? null],
    connection: [s.nodesCard.warn, s.nodesCard.rows.map((r) => r.nodeId)]
  }
}

/** The event-log rows about one board, as `event · detail [severity]`. */
function rows(app: Services, nodeId: number): string[] {
  return app
    .pushesOf('events:batch')
    .flat()
    .filter((e: LogEvent) => e.nodeId === nodeId)
    .map((e: LogEvent) => `${eventText(e)} [${e.severity}]`)
}

const lastSeen = (app: Services, id: number) =>
  app.files.json<NodeMappingFile>('node-mapping.json')?.nodes[id]?.lastSeen

describe('D1 / X3 / S6: a stray is counted on every tab, 5 s after it comes online', () => {
  it('an unidentified board: nothing at first, then one warning on the Cockpit, Overview and Connection', () => {
    const app = makeServices({ paths: { files: COCKPIT } })
    app.serial.open()
    reply(app, [[1, PANEL]])
    app.serial.receive(statusLine(9, true, UNREPORTED)) // on the bus, kind not reported
    app.clock.advance(1000)
    const none = { cockpit: [0, []], overview: ['1 / 1', null], connection: [0, []] }
    expect(strayCounts(app)).toEqual(none)
    app.clock.advance(4200) // 5 s since it came online
    expect(strayCounts(app)).toEqual({
      cockpit: [1, [9]],
      overview: ['2 / 2', '1 warning (NODE_ID 9)'],
      connection: [1, [9]]
    })
  })

  it('the grace counts from coming online: listed absent a minute, then online, it waits 5 s', () => {
    const app = makeServices({ paths: { files: COCKPIT } })
    app.serial.open()
    reply(app, [[1, PANEL]])
    app.serial.receive(statusLine(9, false, UNREPORTED)) // first seen absent
    app.clock.advance(60_000)
    app.serial.receive(statusLine(9, true, UNREPORTED)) // online now
    app.clock.advance(1000)
    expect(snap(app).attention.items.filter((i) => i.stray)).toEqual([])
    expect(snap(app).views.find((v) => v.entry.nodeId === 9)?.entry.onlineSince).toBe(
      app.clock.now() - 1000
    )
    app.clock.advance(4200)
    expect(strayCounts(app).connection).toEqual([1, [9]])
  })
})

describe('X8 / C6: a registry board waiting to be added is "from NODE_IDS.md"', () => {
  it('its flag, and its "new on the bus" row', () => {
    const app = makeServices({ paths: { files: COCKPIT } })
    app.serial.open()
    reply(app, [
      [1, PANEL],
      [2, PANEL] // Right_Navigation, in NODE_IDS.md, not added
    ])
    app.clock.advance(1000)
    expect(snap(app).views.find((v) => v.entry.nodeId === 2)?.health.flag).toBe('FROM NODE_IDS.md')
    expect(rows(app, 2)).toEqual(['new on the bus · from NODE_IDS.md [new]'])
  })
})

describe('D8 / S5 / C4: the log is the physical bus', () => {
  it('a board outside your cockpit is logged at info, labelled; yours stays an error', () => {
    const app = makeServices({ paths: { files: COCKPIT } })
    app.serial.open()
    reply(app, [
      [1, PANEL],
      [41, PANEL]
    ])
    app.clock.advance(1000)
    app.serial.receive(statusLine(41, false, PANEL))
    app.serial.receive(statusLine(1, false, PANEL))
    app.clock.advance(1000)
    expect(rows(app, 41)).toEqual([
      'new on the bus · not in NODE_IDS.md [new]',
      'offline · no heartbeat · not in your cockpit [info]'
    ])
    expect(rows(app, 1)).toEqual(['offline · no heartbeat [error]'])
    const roster = app
      .pushesOf('events:batch')
      .flat()
      .find((e) => e.name === 'roster')
    expect(roster && eventText(roster)).toBe('2 nodes online · 1 not in your cockpit')
  })

  it('Forget clears the "seen new" record: plugged back in, it is new again', () => {
    const app = makeServices({ paths: { files: COCKPIT } })
    app.serial.open()
    reply(app, [[1, PANEL]])
    app.serial.receive(statusLine(41, true, PANEL))
    app.clock.advance(1000)
    const spec = { name: 'Left_Oxygen', console: 'Left', pduId: null, kind: 'panel' } as const
    expect(app.invoke(CTRL.nodeMappingAdopt, 41, spec).ok).toBe(true)
    app.serial.receive(statusLine(41, false, PANEL)) // unplugged
    app.clock.advance(1000)
    expect(app.invoke(CTRL.nodeMappingForget, 41).ok).toBe(true)
    app.serial.receive(statusLine(41, true, PANEL)) // plugged back in
    app.clock.advance(1000)
    expect(rows(app, 41).filter((r) => r.startsWith('new on the bus'))).toEqual([
      'new on the bus · not in NODE_IDS.md [new]',
      'new on the bus · not in NODE_IDS.md [new]'
    ])
  })

  it('a board online by its PDU pages alone: last seen, and its online / offline rows', () => {
    const app = makeServices({ paths: { files: WITH_PDU } })
    app.serial.open()
    reply(app, [[1, PANEL]]) // PDU_Left (3) is not in the roster
    app.clock.advance(1000)
    const at = app.clock.now()
    app.serial.receive('_NODE_TELEM 030100E02E182EBC02\n') // its 12 V page
    app.clock.advance(1000)
    const came = Date.parse(lastSeen(app, 3)!) // seen at the link's next flush
    expect(came - at).toBeGreaterThanOrEqual(0)
    expect(came - at).toBeLessThan(1000)
    expect(rows(app, 3)).toEqual(['online [info]'])
    app.clock.advance(12_000) // its pages go stale
    expect(rows(app, 3)).toEqual(['online [info]', 'offline · no telemetry [error]'])
    expect(Date.parse(lastSeen(app, 3)!)).toBeGreaterThanOrEqual(came + 10_000) // when it went
  })
})
