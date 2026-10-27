// SESSION-seam tests for #171 through the services harness: the Gateway's status rows carry each
// board's firmware release (v4); the test reads only the pushes.
import { describe, expect, it } from 'vitest'
import { FIRMWARE_RELEASE } from '@shared/firmware'
import { makeServices, type Services } from '../test-harness/services'

/** Board 1 is in your cockpit. */
const COCKPIT = { 'node-mapping.json': { version: 4, nodes: { 1: { added: true } } } }

const hex = (n: number) => n.toString(16).padStart(2, '0')

/** A v4 row: present, healthy, 30 °C, kind `kind`, firmware `v`. */
const row = (id: number, kind: number, v: [number, number, number]) =>
  `_NODE_STATUS ${hex(id)}01000064000a00001e000000${hex(kind)}${v.map(hex).join('')}0100\n`

/** One roster reply: the Gateway's own row, board 1, the END. */
const reply = (gw: [number, number, number], board: [number, number, number]) =>
  row(0, 3, gw) + row(1, 1, board) + '_NODE_STATUS_END 2\n'

const snapshot = (app: Services) => app.lastPush('cockpit:snapshot')!
const gateway = (app: Services) => app.lastPush('device:status')?.gateway

function connect(gw: [number, number, number], board: [number, number, number]) {
  const app = makeServices({ paths: { files: COCKPIT } })
  app.serial.open()
  app.serial.receive(reply(gw, board))
  app.clock.advance(250)
  return app
}

describe('#171 firmware releases, wire to pushes', () => {
  it('the Gateway’s release rides on device:status; each board’s is in the snapshot', () => {
    const m = FIRMWARE_RELEASE.major
    const app = connect([m, 1, 0], [m, 0, 3])
    expect(gateway(app)?.firmware).toEqual({
      version: { major: m, minor: 1, patch: 0 },
      tooNew: false,
      supportedMajor: m
    })
    expect(snapshot(app).panels[1]!.firmware).toEqual({ installed: `${m}.0.3` })
    expect(snapshot(app).attention.items).toEqual([])
  })

  it('a board on another major: an Attention item and a box; a reflash clears it in place', () => {
    const m = FIRMWARE_RELEASE.major
    const app = connect([m + 1, 0, 0], [m, 2, 0])
    expect(gateway(app)?.firmware?.tooNew).toBe(true)
    expect(snapshot(app).attention.items.map((i) => i.flag)).toEqual([
      `runs firmware ${m}.x, Gateway runs ${m + 1}.x — reflash it`
    ])
    expect(snapshot(app).panels[1]!.faults[0]!.title).toBe('Firmware mismatch')
    // The board is reflashed: the bridge pushes its row with the new release.
    app.serial.receive(row(1, 1, [m + 1, 0, 0]))
    app.clock.advance(250)
    expect(snapshot(app).attention.items).toEqual([])
    expect(snapshot(app).panels[1]!.firmware).toEqual({ installed: `${m + 1}.0.0` })
  })

  it('a board that hasn’t reported (0.0.0) is never a mismatch', () => {
    const app = connect([FIRMWARE_RELEASE.major + 1, 0, 0], [0, 0, 0])
    expect(snapshot(app).attention.items).toEqual([])
    expect(snapshot(app).panels[1]!.firmware.installed).toBe('version not reported')
  })
})
