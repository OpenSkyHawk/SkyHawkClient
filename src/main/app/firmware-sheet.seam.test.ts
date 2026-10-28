// SESSION-seam tests for the Firmware sheet (#173), through the services harness: the release
// check saves firmware 0.3.0 from a fake GitHub, a simulated Gateway answers HELLO with its USB
// side's release and sends its status rows, and the test reads only the Cockpit snapshot.
import { describe, expect, it, vi } from 'vitest'
import { makeServices, type Services } from '../test-harness/services'

// After the harness, so main is loaded against its fakes.
const { CAL_TYPE, buildFrame } = await import('../hid/calibration/codec')
const { buildRelease, FakeGitHub } = await import('../../test-fixtures/releases')

const MAGIC = Buffer.from([0xaa, 0x53, 0x4b, 0x43])
/** Board 1 (a panel group) is in your cockpit. */
const COCKPIT = { 'node-mapping.json': { version: 4, nodes: { 1: { added: true } } } }

const hex = (n: number) => n.toString(16).padStart(2, '0')
/** A v4 row: present, healthy, kind `kind`, firmware `v`, a bootloader, the app running. */
const row = (id: number, kind: number, v: [number, number, number]) =>
  `_NODE_STATUS ${hex(id)}01000064000a00001e000000${hex(kind)}${v.map(hex).join('')}0100\n`

/** The Gateway's calibration channel: HELLO_ACK with its USB side on `usb`; nothing else answers. */
function gateway(app: Services, usb: [number, number, number]) {
  let seen = 0
  const answer = () => {
    const wire = Buffer.concat(app.serial.written())
    for (let at = wire.indexOf(MAGIC, seen); at !== -1; at = wire.indexOf(MAGIC, at + 1)) {
      if (at + 8 > wire.length) break
      const len = wire.readUInt16LE(at + 6)
      if (at + 10 + len > wire.length) break
      seen = at + 10 + len
      if (wire[at + 4] === CAL_TYPE.HELLO) {
        app.serial.receive(
          buildFrame(CAL_TYPE.HELLO_ACK, wire[at + 5]!, Uint8Array.of(1, 1, 8, ...usb))
        )
      }
    }
  }
  return async (ms: number) => {
    for (let t = 0; t < ms; t += 10) {
      await vi.advanceTimersByTimeAsync(10)
      answer()
    }
  }
}

const firmware = (app: Services) => app.lastPush('cockpit:snapshot')!.firmware
const status = (app: Services, key: string) => firmware(app).rows.find((r) => r.key === key)

async function launch() {
  const github = new FakeGitHub()
  github.publish(buildRelease('0.3.0'))
  const app = makeServices({ github: github.fetch, paths: { files: COCKPIT } })
  await vi.waitFor(() => expect(app.lastPush('releases:state')?.cached).toHaveLength(1))
  return app
}

describe('#173 the Firmware sheet, wire to pushes', () => {
  it('USB side from HELLO_ACK, cockpit side and boards from their rows, against the saved 0.3.0', async () => {
    const app = await launch()
    expect(firmware(app).target).toBe('0.3.0')
    const run = gateway(app, [0, 2, 0])
    app.serial.open()
    app.serial.receive(row(0, 3, [0, 3, 0]) + row(1, 1, [0, 3, 0]) + '_NODE_STATUS_END 2\n')
    await run(400)
    expect(status(app, 'usb')).toMatchObject({ status: 'update', version: '0.2.0' })
    expect(status(app, 'cockpit')).toMatchObject({ status: 'ok', version: '0.3.0' })
    // 0.3.0 has no image for a panel group.
    expect(status(app, '1')).toMatchObject({ status: 'custom', version: '0.3.0' })
    expect(firmware(app).attention).toBe(1)
    expect(app.lastPush('cockpit:snapshot')!.overview.firmware).toEqual({
      version: '0.3.0',
      gateway: true,
      pdus: 0,
      boards: 0,
      manual: 0
    })
  })

  it('with the link gone every row reads not reported, and the banner goes', async () => {
    const app = await launch()
    const run = gateway(app, [0, 2, 0])
    app.serial.open()
    await run(400)
    expect(status(app, 'usb')?.status).toBe('update')
    app.serial.close()
    await run(100)
    expect(firmware(app).rows.every((r) => r.status === 'not-reported')).toBe(true)
    expect(app.lastPush('cockpit:snapshot')!.overview.firmware).toBeNull()
  })
})
