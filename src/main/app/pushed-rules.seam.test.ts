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
  it('Bridge with no board: Start blocked; the board arriving lifts it', () => {
    const app = makeServices({ paths: { files: { 'config.json': { sourceMode: 'bridge' } } } })
    expect(app.lastPush('relay:facts')?.stopped.startBlocked).toBe('bridge')
    app.serial.open()
    expect(app.lastPush('relay:facts')?.stopped.startBlocked).toBeUndefined()
    expect(app.lastPush('relay:facts')?.running.waiting).toBe('dcs')
  })

  it('toggle: Start saves the settings first; a refused Start pushes no relay state', () => {
    const app = makeServices({ paths: { files: { 'config.json': { sourceMode: 'bridge' } } } })
    const states = app.pushesOf('relay:state').length
    expect(app.invoke(CTRL.relayToggle, false)).toEqual({
      ok: false,
      error: 'Gateway is not connected'
    })
    expect(app.pushesOf('relay:state')).toHaveLength(states)
    expect(app.files.json('config.json')).toMatchObject({ sourceMode: 'bridge', commandPort: 7778 })
    expect(app.lastPush('config:changed')?.source).toBe('edit')
    app.serial.open()
    expect(app.invoke(CTRL.relayToggle, false)).toEqual({ ok: true })
    expect(app.lastPush('relay:state')).toEqual({ running: true, stream: 'connecting' })
    expect(app.invoke(CTRL.relayToggle, true)).toEqual({ ok: true })
    expect(app.lastPush('relay:state')).toEqual({ running: false })
  })

  it('a form’s edit: built over the settings held, the port as typed; the facts follow', () => {
    const app = makeServices(monitor)
    app.invoke(CTRL.configEdit, { transport: 'unicast-listen' })
    expect(app.lastPush('relay:facts')?.endpoint).toBe('0.0.0.0:5010')
    app.invoke(CTRL.configEdit, { port: '77a' })
    expect(app.files.json('config.json')).toMatchObject({
      transport: 'unicast-listen',
      commandPort: 7778
    })
    expect(app.invoke(CTRL.configGet).config.commandPort).toBe(7778)
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
    expect(app.lastPush('relay:facts')?.endpoint).toBe('0.0.0.0:5010')
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
