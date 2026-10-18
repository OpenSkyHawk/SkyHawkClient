// R3.3 SESSION-seam tests: the rules the renderer used to work out from main's pushes, now pushed
// by their owners — the link's facts (device:status), the relay's (relay:facts), the HID report's
// (hid:report) and the settings (config:changed) — through the services harness. R3.4a adds the
// link's action and Refresh (device:status), the Record visibility (relay:facts) and the PSU mode
// switch (config:edit).
import { describe, expect, it } from 'vitest'
import { CTRL } from '@shared/app'
import { serializeCapture } from '../dcs/capture-file'
import { makeServices } from '../test-harness/services'

const monitor = { paths: { files: { 'config.json': { sourceMode: 'monitor' } } } }

describe('device:status carries the link’s facts', () => {
  it('up, the board present, busy; the last-known time stamped on a drop', () => {
    const app = makeServices(monitor)
    expect(app.lastPush('device:status')).toMatchObject({
      state: 'scanning',
      linkUp: false,
      boardPresent: false,
      busy: false,
      serialMonitor: false
    })
    app.serial.open()
    expect(app.lastPush('device:status')).toMatchObject({ linkUp: true, boardPresent: true })
    expect(app.lastPush('device:status')?.linkDownAt).toBeUndefined()
    const at = app.clock.now()
    app.serial.close()
    expect(app.lastPush('device:status')).toMatchObject({
      state: 'reconnecting',
      linkUp: false,
      linkDownAt: at
    })
    app.serial.fail('Resource busy')
    expect(app.lastPush('device:status')).toMatchObject({
      state: 'error',
      busy: true,
      linkDownAt: at
    })
  })

  it('the serial monitor’s flag comes back on device:status; a reloaded page keeps it (N1)', () => {
    const app = makeServices(monitor)
    app.serial.open()
    const n = app.pushesOf('device:status').length
    app.invoke(CTRL.serialMonitor, true)
    expect(app.pushesOf('device:status')).toHaveLength(n + 1)
    expect(app.lastPush('device:status')).toMatchObject({ state: 'connected', serialMonitor: true })
    const at = app.clock.now()
    app.serial.close()
    const reloaded = app.invoke(CTRL.relayStatus)
    expect(reloaded.device).toMatchObject({ serialMonitor: true })
    expect(reloaded.device.linkDownAt, 'the last-known time, as main holds it').toBe(at)
  })
})

describe('relay:facts: what the relay’s surfaces show', () => {
  // #159: Start with no board used to be refused ('Gateway is not connected'): the pill flipped
  // back to Stopped with no word why. Now it starts and waits, and the board arriving delivers.
  it('Bridge with no board: Start starts and waits for the board; the board arriving delivers', () => {
    const app = makeServices({ paths: { files: { 'config.json': { sourceMode: 'bridge' } } } })
    expect(app.lastPush('relay:facts')?.stopped).not.toHaveProperty('startBlocked')
    expect(app.invoke(CTRL.relayToggle, false)).toEqual({ ok: true })
    expect(app.lastPush('relay:state')).toEqual({ running: true, stream: 'connecting' })
    expect(app.lastPush('relay:facts')?.running).toMatchObject({
      waiting: 'device',
      tip: 'waiting-device',
      overviewLink: 'waiting'
    })
    app.transport.connected(true)
    // The board arrives: no further click, the relay delivers to it.
    app.serial.open()
    expect(app.lastPush('relay:facts')?.running).toMatchObject({
      waiting: 'none',
      tip: 'delivering'
    })
    app.serial.clearWritten()
    app.transport.export('UUUU')
    expect(app.serial.writtenText()).toBe('UUUU')
    expect(app.lastPush('relay:state')?.running, 'still the one relay').toBe(true)
  })

  it('a driven Replay with no board: Start plays and waits for the board (#159)', async () => {
    const app = makeServices({
      paths: {
        files: {
          'config.json': { sourceMode: 'replay', replayDriveSerial: true },
          'flight.skyhawk-capture': serializeCapture([{ t: 0, dir: 'in', hex: '55555555' }])
        }
      }
    })
    app.dialogs.openCapture('flight.skyhawk-capture')
    await app.invoke(CTRL.replayOpen)
    expect(app.invoke(CTRL.relayToggle, false)).toEqual({ ok: true })
    expect(app.lastPush('relay:facts')?.running).toMatchObject({
      waiting: 'device',
      tip: 'waiting-device',
      overviewLink: 'waiting'
    })
    app.serial.open()
    expect(app.lastPush('relay:facts')?.running.tip).toBe('replay-playing')
  })

  it('toggle: Start saves the settings first; a refused Start pushes no relay state', () => {
    // Replay with no capture loaded: the one Start main still refuses.
    const app = makeServices({ paths: { files: { 'config.json': { sourceMode: 'replay' } } } })
    app.serial.open()
    const states = app.pushesOf('relay:state').length
    expect(app.invoke(CTRL.relayToggle, false)).toEqual({ ok: false, error: 'No capture loaded' })
    expect(app.pushesOf('relay:state')).toHaveLength(states)
    expect(app.files.json('config.json')).toMatchObject({ sourceMode: 'replay', commandPort: 7778 })
    expect(app.lastPush('config:changed')?.source).toBe('edit')
    app.invoke(CTRL.configEdit, { sourceMode: 'bridge' })
    expect(app.invoke(CTRL.relayToggle, false)).toEqual({ ok: true })
    expect(app.lastPush('relay:state')).toEqual({ running: true, stream: 'connecting' })
    expect(app.invoke(CTRL.relayToggle, true)).toEqual({ ok: true })
    expect(app.lastPush('relay:state')).toEqual({ running: false })
  })

  it('a form’s edit: built over the settings held, a typed port checked (N5); the facts follow', () => {
    const app = makeServices(monitor)
    app.invoke(CTRL.configEdit, { transport: 'unicast-listen' })
    expect(app.lastPush('relay:facts')?.endpoint).toBe('this PC:5010')
    expect(app.invoke(CTRL.configEdit, { port: '7781' })).toMatchObject({
      ok: true,
      config: { commandPort: 7781 }
    })
    // N5: a port that is not one is refused with why; nothing is saved, nothing pushed.
    const changes = app.pushesOf('config:changed').length
    expect(app.invoke(CTRL.configEdit, { port: '77a' })).toEqual({
      ok: false,
      error: 'Not a port. Enter a whole number from 1 to 65535.'
    })
    expect(app.files.json('config.json')).toMatchObject({
      transport: 'unicast-listen',
      commandPort: 7781
    })
    expect(app.invoke(CTRL.configGet).config.commandPort).toBe(7781)
    expect(app.pushesOf('config:changed')).toHaveLength(changes)
  })
})

describe('fix track #134: the relay endpoint, Record and the waiting wording', () => {
  it('X9: one endpoint, from the settings held, right for each transport', () => {
    const app = makeServices(monitor)
    expect(app.lastPush('relay:facts')?.endpoint).toBe('127.0.0.1:7778')
    app.invoke(CTRL.configEdit, { host: '10.0.0.7', port: '7779' })
    expect(app.lastPush('relay:facts')?.endpoint).toBe('10.0.0.7:7779')
    app.invoke(CTRL.configEdit, { transport: 'loopback-multicast' })
    expect(app.lastPush('relay:facts')?.endpoint).toBe('239.255.50.10:5010')
    app.invoke(CTRL.configEdit, { transport: 'unicast-listen' })
    expect(app.lastPush('relay:facts')?.endpoint).toBe('this PC:5010')
  })

  it('X12: Record refused while stopped, before any dialog; allowed while relaying', async () => {
    const app = makeServices(monitor)
    expect(app.lastPush('relay:facts')).toMatchObject({
      running: { canRecord: true },
      stopped: { canRecord: false }
    })
    app.dialogs.saveCapture('session.skyhawk-capture')
    expect(await app.invoke(CTRL.captureToggle)).toEqual({ recording: false })
    expect(app.lastPush('relay:facts')?.recording).toEqual({ on: false })
    app.invoke(CTRL.relayStart)
    expect(await app.invoke(CTRL.captureToggle)).toMatchObject({ recording: true })
    // Stopped mid-recording: the recording can still be stopped.
    app.invoke(CTRL.relayStop)
    expect(app.lastPush('relay:facts')?.stopped.canRecord).toBe(true)
    expect(await app.invoke(CTRL.captureToggle)).toMatchObject({ recording: false })
    expect(app.lastPush('relay:facts')?.stopped.canRecord).toBe(false)
  })

  it('N2: Monitor relaying with no Gateway is running, not waiting for it', () => {
    const app = makeServices(monitor)
    app.invoke(CTRL.relayStart)
    expect(app.lastPush('relay:facts')?.running).toMatchObject({
      overviewLink: 'running',
      tip: 'waiting-dcs',
      waiting: 'dcs'
    })
  })

  it('N3: a driven Replay that loses the Gateway waits for it, as Bridge does', async () => {
    const app = makeServices({
      paths: {
        files: {
          'config.json': { sourceMode: 'replay', replayDriveSerial: true },
          'flight.skyhawk-capture': serializeCapture([
            { t: 0, dir: 'in', hex: '55555555' },
            { t: 1500, dir: 'in', hex: '55555555' }
          ])
        }
      }
    })
    app.dialogs.openCapture('flight.skyhawk-capture')
    await app.invoke(CTRL.replayOpen)
    app.serial.open()
    expect(app.invoke(CTRL.relayStart)).toEqual({ ok: true })
    expect(app.lastPush('relay:facts')?.running.tip).toBe('replay-playing')
    app.serial.close()
    expect(app.lastPush('relay:facts')?.running).toMatchObject({
      waiting: 'device',
      tip: 'waiting-device',
      overviewLink: 'waiting'
    })
  })
})

describe('R3.4a: the last renderer decisions, pushed by their owners', () => {
  it('device:status: the link’s action, and no Refresh fact (#132: the button is gone)', () => {
    const app = makeServices(monitor)
    expect(app.lastPush('device:status')).toMatchObject({
      state: 'scanning',
      action: { offer: 'disconnect', intent: 'disconnect', disabled: true }
    })
    app.serial.open()
    expect(app.lastPush('device:status')).toMatchObject({
      state: 'connected',
      action: { offer: 'disconnect', intent: 'disconnect' }
    })
    app.serial.close()
    app.serial.fail('EIO')
    expect(app.lastPush('device:status')).toMatchObject({
      state: 'error',
      action: { offer: 'retry', intent: 'connect' }
    })
    app.invoke(CTRL.deviceDisconnect)
    expect(app.lastPush('device:status')).toMatchObject({
      state: 'disconnected',
      action: { offer: 'connect', intent: 'connect' }
    })
    for (const push of app.pushesOf('device:status')) expect(push).not.toHaveProperty('canRefresh')
  })

  it('relay:facts: Record hidden and Capture shown in Replay, together; Settings’ row always', () => {
    const app = makeServices(monitor)
    expect(app.lastPush('relay:facts')).toMatchObject({
      recordShown: { connection: true, settings: true },
      captureShown: false
    })
    app.invoke(CTRL.configEdit, { sourceMode: 'replay' })
    expect(app.lastPush('relay:facts')).toMatchObject({
      recordShown: { connection: false, settings: true },
      captureShown: true
    })
  })

  it('config:edit: a PSU mode switch and a typed limit over the setting held; refused = nothing', () => {
    const custom = { a12: 40, w: 500 }
    const app = makeServices({
      paths: {
        files: {
          'config.json': { sourceMode: 'monitor', psu: { mode: 'preset', preset: 'nx650', custom } }
        }
      }
    })
    app.invoke(CTRL.configEdit, { psuMode: 'custom' })
    const psu = { mode: 'custom', preset: 'nx650', custom }
    expect(app.files.json('config.json')).toMatchObject({ psu })
    expect(app.lastPush('config:changed')).toMatchObject({ source: 'edit', config: { psu } })
    const n = app.pushesOf('config:changed').length
    app.invoke(CTRL.configEdit, { psuLimit: { key: 'a5', text: '15' } })
    expect(app.files.json('config.json')).toMatchObject({
      psu: { custom: { a12: 40, a5: 15, w: 500 } }
    })
    app.invoke(CTRL.configEdit, { psuLimit: { key: 'a5', text: '15x' } })
    expect(app.pushesOf('config:changed'), 'a refused limit pushes nothing').toHaveLength(n + 1)
  })
})
