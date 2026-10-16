import { describe, expect, it } from 'vitest'
import type { DeviceState } from '@shared/ipc'
import { deviceView, relayNote, relayTip, relayWaiting, startBlocked } from './device-view'

const STATES: DeviceState[] = [
  'connected',
  'scanning',
  'reconnecting',
  'no-device',
  'disconnected',
  'error'
]

describe('deviceView', () => {
  it('gives every state a distinct label and indicator style', () => {
    const views = STATES.map((s) => deviceView(s, { autoConnect: true }))
    expect(new Set(views.map((v) => v.label)).size).toBe(STATES.length)
    expect(new Set(views.map((v) => v.cls)).size).toBe(STATES.length)
  })

  it('shows the port only while connected', () => {
    expect(deviceView('connected', { port: '/dev/cu.x', autoConnect: true }).portRow).toBe(
      '/dev/cu.x'
    )
    expect(deviceView('disconnected', { port: '/dev/cu.x', autoConnect: true }).portRow).toBe(
      'released'
    )
    expect(deviceView('no-device', { autoConnect: true }).portRow).toBe('waiting for the board…')
  })

  it('offers Connect when released, Retry on error, Disconnect otherwise', () => {
    expect(deviceView('disconnected', { autoConnect: true }).button).toMatchObject({
      label: 'Connect',
      action: 'connect'
    })
    expect(deviceView('error', { autoConnect: true }).button).toMatchObject({
      label: 'Retry',
      action: 'connect'
    })
    for (const s of ['connected', 'reconnecting', 'no-device'] as const) {
      expect(deviceView(s, { autoConnect: true }).button.action, s).toBe('disconnect')
    }
    expect(deviceView('scanning', { autoConnect: true }).button.disabled).toBe(true)
  })

  it('names another program holding the port as busy', () => {
    const v = deviceView('error', { port: 'COM4', detail: 'Access denied', autoConnect: true })
    expect(v.portRow).toBe('COM4 · busy')
    expect(v.note).toMatch(/another app/)
    expect(v.tip).toContain('Access denied')
    expect(deviceView('error', { port: 'COM4', detail: 'EIO', autoConnect: true }).portRow).toBe(
      'COM4 · error'
    )
  })

  it('explains a released port by whether auto-connect is on', () => {
    const manual = deviceView('disconnected', { autoConnect: true })
    const auto = deviceView('disconnected', { autoConnect: false })
    expect(manual.tip).toMatch(/Port released/)
    expect(manual.popMeta).toMatch(/Port released/)
    expect(manual.noteSettingsLink).toBe(false)
    expect(auto.tip).toMatch(/automatically is off/)
    expect(auto.popMeta).toMatch(/Automatic connection is off/)
    expect(auto.noteSettingsLink, 'the setting lives in Settings › Connection').toBe(true)
  })

  it('has a note only when the link needs explaining', () => {
    for (const s of ['connected', 'scanning', 'reconnecting', 'no-device'] as const) {
      expect(deviceView(s, { autoConnect: true }).note, s).toBeUndefined()
    }
  })
})

describe('relayTip', () => {
  const base = {
    mode: 'bridge' as const,
    relaying: true,
    stream: 'connected' as const,
    deviceState: 'connected' as const,
    deviceLabel: 'SimGateway',
    endpoint: '127.0.0.1:7778'
  }

  it('describes the stream while relaying, and a stopped relay', () => {
    expect(relayTip(base)).toBe('DCS-BIOS stream · connected · 127.0.0.1:7778 — click to stop')
    expect(relayTip({ ...base, relaying: false })).toBe('DCS-BIOS stream stopped — click to start')
  })

  it('says what a running relay is waiting for, the device first', () => {
    expect(relayTip({ ...base, deviceState: 'reconnecting', deviceLabel: 'Reconnecting' })).toBe(
      'Relaying — waiting for the SimGateway (device link reconnecting). Resumes when it connects — click to stop'
    )
    expect(relayTip({ ...base, stream: 'reconnecting' })).toBe(
      'Relaying — waiting for DCS-BIOS (reconnecting) · 127.0.0.1:7778 — click to stop'
    )
  })

  it('leaves the device out in Monitor, which never uses it', () => {
    expect(relayTip({ ...base, mode: 'monitor', deviceState: 'no-device' })).not.toContain(
      'device link'
    )
  })

  it('reports Replay as playing or ended', () => {
    const replay = { ...base, mode: 'replay' as const, replayFile: '/tmp/a4ec.json' }
    expect(relayTip(replay)).toBe('Replay · playing a4ec.json — click to stop')
    expect(relayTip({ ...replay, stream: 'ended' })).toBe('Replay · ended — click to stop')
    expect(relayTip({ ...replay, relaying: false })).toBe('Replay stopped — click to play')
  })
})

describe('relayWaiting', () => {
  const run = {
    mode: 'bridge' as const,
    relaying: true,
    stream: 'connected' as const,
    deviceState: 'connected' as const
  }

  it('is green only when the stream is up and, in Bridge, the device too', () => {
    expect(relayWaiting(run)).toBe(false)
    expect(relayWaiting({ ...run, deviceState: 'disconnected' })).toBe(true)
    expect(relayWaiting({ ...run, deviceState: 'reconnecting' })).toBe(true)
    expect(relayWaiting({ ...run, stream: 'reconnecting' })).toBe(true)
    expect(relayWaiting({ ...run, stream: 'ended' })).toBe(true)
  })

  it('ignores the device outside Bridge', () => {
    expect(relayWaiting({ ...run, mode: 'monitor', deviceState: 'no-device' })).toBe(false)
    expect(relayWaiting({ ...run, mode: 'replay', deviceState: 'disconnected' })).toBe(false)
  })

  it('is never waiting while stopped', () => {
    expect(relayWaiting({ ...run, relaying: false, stream: undefined })).toBe(false)
  })
})

describe('relayNote', () => {
  const run = {
    mode: 'bridge' as const,
    relaying: true,
    stream: 'connected' as const,
    deviceState: 'connected' as const
  }

  it('is silent while delivering', () => {
    expect(relayNote(run)).toBeUndefined()
    expect(relayNote({ ...run, relaying: false, stream: undefined })).toBeUndefined()
  })

  it('says what a running relay waits for', () => {
    expect(relayNote({ ...run, deviceState: 'no-device' })).toEqual({
      text: 'Relaying — waiting for the SimGateway. Resumes when it connects.',
      info: false
    })
    expect(relayNote({ ...run, stream: 'error' })?.text).toBe(
      'Relaying — waiting for DCS-BIOS (error).'
    )
    expect(relayNote({ ...run, mode: 'replay', stream: 'ended' })?.text).toMatch(/Replay ended/)
  })
})

describe('startBlocked', () => {
  const at = (
    mode: 'bridge' | 'monitor' | 'replay',
    deviceState: DeviceState,
    replayDriveSerial = false
  ) => startBlocked({ mode, deviceState, replayDriveSerial })

  it('needs the board in Bridge, and in Replay only when driving it', () => {
    for (const s of STATES.filter((x) => x !== 'connected')) {
      expect(at('bridge', s), s).toBe(true)
      expect(at('replay', s, true), s).toBe(true)
      expect(at('replay', s, false), s).toBe(false)
      expect(at('monitor', s), s).toBe(false)
    }
    expect(at('bridge', 'connected')).toBe(false)
    expect(at('replay', 'connected', true)).toBe(false)
  })
})
