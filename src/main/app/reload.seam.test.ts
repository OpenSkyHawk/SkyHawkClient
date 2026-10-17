// N1 SESSION-seam test: a renderer that (re)loads is handed what main still holds for the screen —
// the recording, the loaded capture, the serial monitor's flag, the aircraft, the gauges, the
// session's peak W and the link's last-known time — in the rehydrate bundle (`relay:status`) and
// the pushes its load sends. Before, main cleared its page-held copies on `relay:status`.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CTRL } from '@shared/app'
import { AIRCRAFT_NONE, TELEMETRY_IDLE } from '@shared/dcs'
import { A4EC_OUTPUTS_BY_ADDRESS } from '@shared/firmware'
import { serializeCapture } from '../dcs/capture-file'
import { makeServices } from '../test-harness/services'
import { statusLine } from '../../test-fixtures/nodes'

/** The A-4E-C address carrying RPM, a gauge the telemetry tick reads. */
const [RPM_ADDRESS] = [...A4EC_OUTPUTS_BY_ADDRESS].find(([, o]) => o.some((x) => x.id === 'RPM'))!

/** One DCS-BIOS export frame: sync, then 16-bit writes from `address` on. */
function exportFrame(address: number, words: number[]): Buffer {
  const head = [0x55, 0x55, 0x55, 0x55, address & 0xff, address >> 8, words.length * 2, 0]
  return Buffer.from([...head, ...words.flatMap((w) => [w & 0xff, w >> 8])])
}

/** `_ACFT_NAME` (address 0, two characters per word), as DCS writes it. */
function aircraftFrame(name: string): Buffer {
  const bytes = Buffer.from(name.padEnd(24, '\0'), 'latin1')
  const words = Array.from(
    { length: bytes.length / 2 },
    (_, i) => bytes[2 * i]! | (bytes[2 * i + 1]! << 8)
  )
  return exportFrame(0, words)
}

/** PDU_Left (node 3), 12 V rail page: 12.00 V average, 11.80 V minimum, `mA` average. */
const railPage = (mA: number) =>
  `_NODE_TELEM 030100E02E182E${(mA & 0xff).toString(16).padStart(2, '0')}${(mA >> 8)
    .toString(16)
    .padStart(2, '0')}\n`

const monitor = {
  paths: {
    files: {
      'config.json': { sourceMode: 'monitor' },
      'flight.skyhawk-capture': serializeCapture([
        { t: 0, dir: 'in', hex: '55555555' },
        { t: 1500, dir: 'in', hex: '55555555' }
      ])
    }
  }
}

describe('a renderer reload keeps what main holds for the screen (N1)', () => {
  it('the recording, the capture, the monitor flag, the aircraft, the gauges, peak W, last known', async () => {
    const app = makeServices(monitor)
    app.serial.open()

    // The Serial tab's monitor on; the Cockpit's PDU drawing 8.4 W, then 1.2 W.
    app.invoke(CTRL.serialMonitor, true)
    app.serial.receive(statusLine(3, true, 2) + '_NODE_STATUS_END\n')
    app.invoke(CTRL.nodeMappingAdopt, 3, {
      name: 'PDU_Left',
      console: 'Left',
      pduId: null,
      kind: 'pdu'
    })
    app.serial.receive(railPage(700))
    app.clock.advance(1000)
    app.serial.receive(railPage(100))
    app.clock.advance(1000)
    const peak = app.lastPush('cockpit:snapshot')!.band.peakW
    expect(peak).toBeCloseTo(8.4)

    // Relaying: DCS names the aircraft and moves RPM; a recording runs; a capture is loaded.
    app.invoke(CTRL.relayStart)
    app.transport.export(aircraftFrame('A-4E-C'))
    app.transport.export(exportFrame(RPM_ADDRESS, [0x8000]))
    app.clock.advance(200)
    const aircraft = app.lastPush('aircraft:changed')!
    const gauges = app.lastPush('telemetry:tick')!
    expect(aircraft).toMatchObject({ name: 'A-4E-C', supported: true })
    expect(gauges).not.toEqual(TELEMETRY_IDLE)
    app.dialogs.saveCapture('session.skyhawk-capture')
    await app.invoke(CTRL.captureToggle)
    app.dialogs.openCapture('flight.skyhawk-capture')
    await app.invoke(CTRL.replayOpen)
    const facts = app.lastPush('relay:facts')!
    expect(facts.recording).toEqual({ on: true })
    expect(facts.replay).toEqual({
      file: join(app.files.dir, 'flight.skyhawk-capture'),
      events: 2,
      durationMs: 1500
    })

    // Stopped, and the Gateway unplugged: the gauges and the aircraft stay as last shown.
    app.invoke(CTRL.relayStop)
    const at = app.clock.now()
    app.serial.close()

    // The window reloads.
    const before = app.pushes.length
    const bundle = app.invoke(CTRL.relayStatus)
    expect(bundle.relayFacts.recording, 'the recording').toEqual({ on: true })
    expect(bundle.relayFacts.replay, 'the loaded capture').toEqual(facts.replay)
    expect(bundle.device.serialMonitor, 'the monitor flag').toBe(true)
    expect(bundle.aircraft, 'the aircraft').toEqual(aircraft)
    expect(bundle.aircraft).not.toEqual(AIRCRAFT_NONE)
    expect(bundle.telemetry, 'the gauges').toEqual(gauges)
    expect(bundle.device.linkDownAt, 'the last-known time').toBe(at)
    const reloaded = app.pushes.slice(before)
    expect(reloaded.map((p) => p.channel)).toContain('cockpit:snapshot')
    expect(app.lastPush('cockpit:snapshot')?.band.peakW, 'peak W').toBe(peak)
    expect(
      reloaded.some((p) => p.channel === 'relay:facts' || p.channel === 'device:status'),
      'nothing main holds changed, so nothing of it is pushed again'
    ).toBe(false)
  })
})
