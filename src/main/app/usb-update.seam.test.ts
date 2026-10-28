// SESSION-seam tests for the Gateway USB side's update (#173), through the services harness: the
// release check saves firmware 0.3.0 from a fake GitHub; a simulated Gateway answers HELLO, GET_CAL
// and a calibration session on its port; the 1200-baud touch mounts a fake update drive, and a copy
// onto it reboots the Gateway into the new firmware. The test reads pushes, intents, the touches,
// the copied file and <userData>.
import { describe, expect, it, vi } from 'vitest'
import { CTRL } from '@shared/app'
import { CAL_COMMIT_FIELD, CAL_DATA_FIELD, CAL_DATA_REC_FIELD, CAL_PROTO } from '@shared/firmware'
import type { UpdateState } from '@shared/update'
import { makeServices, type Services } from '../test-harness/services'

// After the harness, so main is loaded against its fakes.
const { CAL_TYPE, buildFrame } = await import('../hid/calibration/codec')
const { buildRelease, FakeGitHub } = await import('../../test-fixtures/releases')

const MAGIC = Buffer.from([0xaa, 0x53, 0x4b, 0x43])
const DRIVE = '/Volumes/RPI-RP2'
const SERIAL = 'TESTSERIAL'

/** Axis 0, calibrated as this computer saved it. */
const AXIS0 = { min: 1000, centre: 32000, max: 64000 }

interface SimAxis {
  min: number
  centre: number
  max: number
}

/**
 * The Gateway's end of its calibration channel: HELLO with `fw`, GET_CAL from `axes` (slot 0
 * present), a session with COMMIT and SESSION_CLOSE. GET_DIAG goes unanswered (older firmware).
 * `boot()` is a restart into other firmware, its stored calibration as given.
 */
function gateway(app: Services, fw: [number, number, number], axis0?: SimAxis) {
  const sim = { fw, axis0, seen: 0, commits: 0 }
  const u16 = (b: Uint8Array, at: number, v: number) => {
    b[at] = v & 0xff
    b[at + 1] = v >> 8
  }
  const calData = () => {
    const p = new Uint8Array(CAL_DATA_FIELD.RECORDS + 8 * CAL_PROTO.dataRecBytes)
    const a = sim.axis0
    p[CAL_DATA_FIELD.PRESENT_MASK] = 1
    p[CAL_DATA_FIELD.CALIBRATED_MASK] = a && a.min < a.centre && a.centre < a.max ? 1 : 0
    const o = CAL_DATA_FIELD.RECORDS
    u16(p, o + CAL_DATA_REC_FIELD.CONTROL_ID, 0x30)
    if (a) {
      u16(p, o + CAL_DATA_REC_FIELD.MIN, a.min)
      u16(p, o + CAL_DATA_REC_FIELD.CENTRE, a.centre)
      u16(p, o + CAL_DATA_REC_FIELD.MAX, a.max)
    }
    return p
  }
  const answer = () => {
    const wire = Buffer.concat(app.serial.written())
    for (let at = wire.indexOf(MAGIC, sim.seen); at !== -1; at = wire.indexOf(MAGIC, at + 1)) {
      if (at + 8 > wire.length) break
      const type = wire[at + 4]!
      const seq = wire[at + 5]!
      const len = wire.readUInt16LE(at + 6)
      if (at + 10 + len > wire.length) break
      const p = wire.subarray(at + 8, at + 8 + len)
      sim.seen = at + 10 + len
      const reply = (t: number, payload?: Uint8Array) =>
        app.serial.receive(buildFrame(t, seq, payload))
      if (type === CAL_TYPE.HELLO) reply(CAL_TYPE.HELLO_ACK, Uint8Array.of(1, 1, 8, ...sim.fw))
      if (type === CAL_TYPE.GET_CAL) reply(CAL_TYPE.CAL_DATA, calData())
      if (type === CAL_TYPE.SESSION_OPEN)
        reply(CAL_TYPE.SESSION_ACK, Uint8Array.of(0x30, 0x75, 0, 0, p[0]!))
      if (type === CAL_TYPE.COMMIT) {
        sim.commits++
        sim.axis0 = {
          min: p.readUInt16LE(CAL_COMMIT_FIELD.MIN),
          centre: p.readUInt16LE(CAL_COMMIT_FIELD.CENTRE),
          max: p.readUInt16LE(CAL_COMMIT_FIELD.MAX)
        }
        reply(CAL_TYPE.ACK, Uint8Array.of(type))
      }
      if (type === CAL_TYPE.SESSION_CLOSE) reply(CAL_TYPE.ACK, Uint8Array.of(type))
    }
  }
  return {
    sim,
    /** Restart into `fw`, with what survived of its calibration; a new port, nothing read yet. */
    boot(next: [number, number, number], axis?: SimAxis) {
      sim.fw = next
      sim.axis0 = axis
      sim.seen = Buffer.concat(app.serial.written()).length
    },
    /**
     * Let main run for `ms`, answering whatever it asks on the way, every `step` ms (coarser for a
     * long wait with nothing to answer, such as the drive wait).
     */
    async run(ms: number, step = 10) {
      for (let t = 0; t < ms; t += step) {
        await vi.advanceTimersByTimeAsync(step)
        answer()
      }
    }
  }
}

const update = (app: Services) => app.lastPush('update:state') as UpdateState | null

/** Launch with 0.3.0 saved and this computer's calibration copy, the Gateway connected on `fw`. */
async function launch(fw: [number, number, number]) {
  const github = new FakeGitHub()
  github.publish(buildRelease('0.3.0'))
  const app = makeServices({
    github: github.fetch,
    serial: { serialNumber: SERIAL },
    paths: {
      files: {
        'calibration-cache.json': {
          version: 1,
          boards: {
            [SERIAL]: {
              confirmedAt: '2026-10-28T10:00:00.000Z',
              axes: { 0: { ...AXIS0, selfCentring: true } }
            }
          }
        }
      }
    }
  })
  await vi.waitFor(() => expect(app.lastPush('releases:state')?.cached).toHaveLength(1))
  const gw = gateway(app, fw, AXIS0)
  app.serial.open()
  await gw.run(2_500) // HELLO, the DIAG timeout, GET_CAL
  return { app, gw }
}

describe('#173 the Gateway USB side, updated from the saved release', () => {
  it('touch → drive → copy → reconnect → reports 0.3.0; the cleared calibration is restored, one row', async () => {
    const { app, gw } = await launch([0, 2, 0])
    expect(app.lastPush('cockpit:snapshot')!.firmware.rows[0]).toMatchObject({
      key: 'usb',
      status: 'update',
      action: 'update'
    })
    await app.invoke(CTRL.updateOpen, { kind: 'usb' })
    expect(update(app)).toMatchObject({
      phase: 'confirm',
      from: '0.2.0',
      to: '0.3.0',
      canStart: true,
      checks: [
        { kind: 'relay', ok: true },
        { kind: 'link', ok: true },
        { kind: 'image', ok: true, version: '0.3.0' }
      ]
    })

    // The board: the touch mounts its drive; a copy that lands reboots it into 0.3.0, its
    // calibration cleared.
    app.drive.onTouch = () => (app.drive.mounted = DRIVE)
    app.drive.onCopied = () => gw.boot([0, 3, 0], undefined)
    const started = app.invoke(CTRL.updateStart)
    await gw.run(1_000)
    expect(app.touches()).toEqual(['/dev/fake'])
    expect(app.drive.files.map((f) => [f.root, f.name, f.bytes.length])).toEqual([
      [DRIVE, 'gateway-0.3.0.uf2', 294_912]
    ])
    expect(update(app)?.steps.map((s) => s.state)).toEqual(['done', 'done', 'on', 'waiting'])
    expect(app.lastPush('device:status')?.state).toBe('scanning') // looking for the board again
    app.serial.open() // it comes back
    await gw.run(4_000)
    await started
    expect(update(app)).toMatchObject({
      phase: 'done',
      done: { reports: '0.3.0', calibration: 'restored' },
      relayRunning: false
    })
    expect(gw.sim.commits).toBe(1)
    expect(gw.sim.axis0).toEqual(AXIS0)
    const rows = (await app.invoke(CTRL.eventsGet)).filter(
      (e) => e.event === 'calibration restored'
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'Gateway', severity: 'info' })
    expect(app.lastPush('cockpit:snapshot')!.firmware.rows[0]).toMatchObject({ status: 'ok' })
    await app.invoke(CTRL.updateClose)
    expect(update(app)).toBeNull()
  })

  it('no drive after the touch → BOOTSEL; Retry with the drive there copies and finishes', async () => {
    const { app, gw } = await launch([0, 2, 0])
    await app.invoke(CTRL.updateOpen, { kind: 'usb' })
    const started = app.invoke(CTRL.updateStart)
    await gw.run(11_000, 250) // past the drive wait
    await started
    expect(update(app)).toMatchObject({ phase: 'fail', failure: { kind: 'no-drive' } })
    expect(app.drive.files).toEqual([])
    // Plugged in holding BOOTSEL: the drive is there, and there is no port to touch.
    app.drive.mounted = DRIVE
    app.drive.onCopied = () => gw.boot([0, 3, 0], { ...AXIS0 })
    const retried = app.invoke(CTRL.updateRetry)
    await gw.run(500)
    app.serial.open()
    await gw.run(4_000)
    await retried
    expect(app.touches()).toEqual(['/dev/fake']) // the first attempt's only
    expect(update(app)).toMatchObject({ phase: 'done', done: { reports: '0.3.0' } })
    expect(update(app)?.done?.calibration).toBeUndefined() // it kept its calibration
  })

  it('closing after a failure gives the port back: the link looks for the Gateway again', async () => {
    const { app, gw } = await launch([0, 2, 0])
    await app.invoke(CTRL.updateOpen, { kind: 'usb' })
    const started = app.invoke(CTRL.updateStart)
    await gw.run(11_000, 250)
    await started
    expect(update(app)?.failure).toEqual({ kind: 'no-drive' })
    expect(app.lastPush('device:status')?.state).toBe('reconnecting') // held by the update
    await app.invoke(CTRL.updateClose)
    expect(app.lastPush('device:status')?.state).toBe('scanning')
    app.serial.open()
    await gw.run(500)
    expect(app.lastPush('device:status')?.state).toBe('connected')
  })

  it('the relay running blocks the start until it is stopped', async () => {
    const { app } = await launch([0, 2, 0])
    await app.invoke(CTRL.relayStart)
    await app.invoke(CTRL.updateOpen, { kind: 'usb' })
    expect(update(app)).toMatchObject({
      canStart: false,
      checks: [{ kind: 'relay', ok: false }, {}, {}]
    })
    await app.invoke(CTRL.updateStart)
    expect(app.touches()).toEqual([])
    await app.invoke(CTRL.relayStop)
    expect(update(app)).toMatchObject({
      canStart: true,
      checks: [{ kind: 'relay', ok: true }, {}, {}]
    })
  })
})
