// SESSION-seam contract test (Phase 0, row B108): the stream stats the Stream Health and Command
// Activity panels show, as the renderer sees them — the 1 s `stats:tick` push while a relay runs.
// Driven through the services harness, so it pins what the app does today and survives the
// relay's move out of Session.
import { describe, expect, it } from 'vitest'
import { CTRL } from '@shared/app'
import { A4EC_OUTPUTS_BY_ADDRESS } from '@shared/firmware'
import { makeServices, type Services } from '../test-harness/services'

/** An A-4E-C address the decoder names, and how many log rows one write to it decodes to. */
const [ADDRESS, OUTPUTS] = [...A4EC_OUTPUTS_BY_ADDRESS].find(([, o]) => o.length >= 2)!
const ROWS_PER_WRITE = OUTPUTS.length

/** One DCS-BIOS export frame: sync, then `words` 16-bit writes from ADDRESS on. */
function exportFrame(words: number[]): Buffer {
  const head = [0x55, 0x55, 0x55, 0x55, ADDRESS & 0xff, ADDRESS >> 8, words.length * 2, 0]
  return Buffer.from([...head, ...words.flatMap((w) => [w & 0xff, w >> 8])])
}

/** One second on: the next stats tick. */
function tick(app: Services) {
  const before = app.pushesOf('stats:tick').length
  app.clock.advance(1000)
  const ticks = app.pushesOf('stats:tick')
  expect(ticks.length, 'one stats tick per second while relaying').toBe(before + 1)
  return ticks.at(-1)!
}

const idle = {
  bytesInPerSec: 0,
  bytesOutPerSec: 0,
  framesPerSec: 0,
  commandsPerSec: 0,
  commandsTotal: 0,
  lastCommand: undefined,
  errors: 0,
  reconnects: 0
}

describe('B108 the stats tick', () => {
  it('ticks once a second only while relaying, with the uptime of the relay', () => {
    const app = makeServices({ paths: { files: { 'config.json': { sourceMode: 'monitor' } } } })
    app.clock.advance(5000)
    expect(app.pushesOf('stats:tick'), 'no tick while stopped').toEqual([])

    app.invoke(CTRL.relayStart)
    app.clock.advance(999)
    expect(app.pushesOf('stats:tick')).toEqual([])
    expect(tick(app)).toEqual({ ...idle, uptimeSec: 1 })
    expect(tick(app)).toEqual({ ...idle, uptimeSec: 2 })

    app.invoke(CTRL.relayStop)
    const n = app.pushesOf('stats:tick').length
    app.clock.advance(5000)
    expect(app.pushesOf('stats:tick'), 'Stop ends the tick').toHaveLength(n)
  })

  it('counts export bytes in and decoded frames, per second', () => {
    const app = makeServices({ paths: { files: { 'config.json': { sourceMode: 'monitor' } } } })
    app.invoke(CTRL.relayStart)
    const frame = exportFrame([0x1234])
    app.transport.export(frame)
    app.transport.export(frame)
    expect(tick(app)).toEqual({
      ...idle,
      bytesInPerSec: frame.length * 2,
      framesPerSec: ROWS_PER_WRITE * 2, // one write, one row per output at its address
      uptimeSec: 1
    })
    expect(tick(app), 'rates are per second: a quiet second reads 0').toEqual({
      ...idle,
      uptimeSec: 2
    })
  })

  it('counts panel commands (rate, total, last) and the bytes sent to DCS in Bridge', () => {
    const app = makeServices({ paths: { files: { 'config.json': { sourceMode: 'bridge' } } } })
    app.serial.open()
    app.invoke(CTRL.relayStart)
    app.serial.receive('MASTER_ARM 1\nGEAR_LEVER 0\n')
    expect(tick(app)).toEqual({
      ...idle,
      bytesOutPerSec: 'MASTER_ARM 1\nGEAR_LEVER 0\n'.length,
      commandsPerSec: 2,
      commandsTotal: 2,
      lastCommand: 'GEAR_LEVER 0',
      uptimeSec: 1
    })
    app.serial.receive('HOOK 1\n')
    expect(tick(app)).toEqual({
      ...idle,
      bytesOutPerSec: 'HOOK 1\n'.length,
      commandsPerSec: 1,
      commandsTotal: 3,
      lastCommand: 'HOOK 1',
      uptimeSec: 2
    })
    expect(tick(app), 'the total and the last command stay; the rates fall to 0').toEqual({
      ...idle,
      commandsTotal: 3,
      lastCommand: 'HOOK 1',
      uptimeSec: 3
    })
  })

  it('counts commands in Monitor too, with nothing sent to DCS', () => {
    const app = makeServices({ paths: { files: { 'config.json': { sourceMode: 'monitor' } } } })
    app.serial.open()
    app.invoke(CTRL.relayStart)
    app.serial.receive('MASTER_ARM 1\n')
    expect(tick(app)).toEqual({
      ...idle,
      commandsPerSec: 1,
      commandsTotal: 1,
      lastCommand: 'MASTER_ARM 1',
      uptimeSec: 1
    })
    expect(app.transport.sent()).toEqual([])
  })

  it('counts errors from DCS and from the link, and reconnects of both', () => {
    const app = makeServices({
      transport: { connectOnStart: true },
      paths: { files: { 'config.json': { sourceMode: 'monitor' } } }
    })
    app.serial.open()
    app.invoke(CTRL.relayStart)
    app.transport.fail('ECONNREFUSED')
    app.transport.fail('ECONNREFUSED') // a repeat is one event-log row, but two errors here
    app.transport.connected(false) // the DCS link drops
    app.transport.connected(true)
    app.serial.close() // the Gateway is unplugged: the link reconnects
    expect(tick(app)).toEqual({ ...idle, errors: 2, reconnects: 2, uptimeSec: 1 })
    app.serial.open()
    app.serial.fail('Access denied') // a link error
    expect(tick(app)).toEqual({ ...idle, errors: 3, reconnects: 2, uptimeSec: 2 })
  })

  it('starts over on every Start: counters, totals and uptime, but not commands seen stopped', () => {
    const app = makeServices({ paths: { files: { 'config.json': { sourceMode: 'bridge' } } } })
    app.serial.open()
    app.serial.receive('MASTER_ARM 1\n') // stopped: logged, not counted for the next relay
    app.invoke(CTRL.relayStart)
    expect(tick(app)).toEqual({ ...idle, uptimeSec: 1 })
    app.serial.receive('GEAR_LEVER 1\n')
    app.transport.fail('boom')
    app.clock.advance(1500)
    app.invoke(CTRL.relayStop)
    app.clock.advance(3000)
    app.invoke(CTRL.relayStart)
    expect(tick(app)).toEqual({ ...idle, uptimeSec: 1 })
  })

  it('a settings change that rebuilds the relay starts the stats over too', () => {
    const app = makeServices({ paths: { files: { 'config.json': { sourceMode: 'monitor' } } } })
    app.invoke(CTRL.relayStart)
    app.transport.export(exportFrame([1]))
    app.clock.advance(2500)
    app.transport.fail('boom')
    app.invoke(CTRL.configSet, { host: '10.0.0.2' }) // a relay setting: the relay is rebuilt
    expect(tick(app)).toEqual({ ...idle, uptimeSec: 1 })
    app.invoke(CTRL.configSet, { debugMode: true }) // not a relay setting: no rebuild
    expect(tick(app)).toEqual({ ...idle, uptimeSec: 2 })
  })
})
