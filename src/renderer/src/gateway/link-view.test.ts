import { describe, expect, it } from 'vitest'
import type { DeviceState } from '@shared/gateway'
import { isBusy, linkAction } from '../../../main/gateway/link-state'
import {
  relayNote as noteOf,
  relayTip as tipOf,
  relayWaiting,
  startBlocked
} from '../../../main/dcs/relay-rules'
import { deviceView as viewOf, linkButton } from './link-view'
import {
  relayNote as noteText,
  relayTip as tipText,
  startBlockedCallout,
  startBlockedReason
} from '../dcs/relay-view'
import type { SourceMode } from '../config'
import type { StreamState } from '@shared/dcs'

/**
 * The link as the user sees it: main's verdict on the port (`busy`, R3.3) and the action it offers
 * (`action`, R3.4a), worded here.
 */
const deviceView = (state: DeviceState, opts: Omit<Parameters<typeof viewOf>[1], 'busy'>) => ({
  ...viewOf(state, { ...opts, busy: isBusy(opts.detail) }),
  button: linkButton(linkAction(state))
})

/** What the relay's surfaces say: main's judgement (relay-rules, R3.3), worded here. */
interface Relay {
  mode: SourceMode
  /** Replay's "Drive Gateway" (N3). */
  replayDriveSerial: boolean
  relaying: boolean
  stream?: StreamState
  deviceState: DeviceState
}
const relayTip = (o: Relay & { deviceLabel: string; endpoint: string; replayFile?: string }) =>
  tipText({ ...o, tip: tipOf(o) })
const relayNote = (o: Relay) => noteText(noteOf(o), o.stream)

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

  it('names the board Gateway; connected, the popover drops the port line (#94)', () => {
    const v = deviceView('connected', { port: '/dev/cu.x', autoConnect: true })
    expect(v.label).toBe('Gateway')
    expect(v.tip).toBe('Gateway connected · /dev/cu.x')
    expect(v.popMeta).toBe('')
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
    replayDriveSerial: false,
    relaying: true,
    stream: 'connected' as const,
    deviceState: 'connected' as const,
    deviceLabel: 'Gateway',
    endpoint: '127.0.0.1:7778'
  }

  it('describes the stream while relaying, and a stopped relay', () => {
    expect(relayTip(base)).toBe('DCS-BIOS stream · connected · 127.0.0.1:7778 — click to stop')
    expect(relayTip({ ...base, relaying: false })).toBe('DCS-BIOS stream stopped — click to start')
  })

  it('says what a running relay is waiting for, the device first', () => {
    expect(relayTip({ ...base, deviceState: 'reconnecting', deviceLabel: 'Reconnecting' })).toBe(
      'Relaying — waiting for the Gateway (device link reconnecting). Resumes when it connects — click to stop'
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
    replayDriveSerial: false,
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

  it('ignores the device in Monitor and an undriven Replay; a driven Replay waits for it (N3)', () => {
    expect(relayWaiting({ ...run, mode: 'monitor', deviceState: 'no-device' })).toBe(false)
    expect(relayWaiting({ ...run, mode: 'replay', deviceState: 'disconnected' })).toBe(false)
    expect(
      relayWaiting({ ...run, mode: 'replay', replayDriveSerial: true, deviceState: 'disconnected' })
    ).toBe(true)
  })

  it('is never waiting while stopped', () => {
    expect(relayWaiting({ ...run, relaying: false, stream: undefined })).toBe(false)
  })
})

describe('relayNote', () => {
  const run = {
    mode: 'bridge' as const,
    replayDriveSerial: false,
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
      text: 'Relaying — waiting for the Gateway. Resumes when it connects.',
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

describe('startBlockedReason', () => {
  it('tells Replay it can also run undriven', () => {
    expect(startBlockedReason('bridge')).toBe('Connect the Gateway to start the relay.')
    expect(startBlockedReason('replay')).toMatch(/turn Drive Gateway off/)
    expect(startBlockedCallout('bridge')).toBe(
      "The Gateway isn't connected, and the relay delivers to it. Connect first."
    )
    expect(startBlockedCallout('replay')).toMatch(/Connect first, or turn Drive off/)
  })
})
