// R3.3: what the relay's surfaces show, decided here and pushed on relay:facts (the renderer's
// device-view.ts, RelayPill.tsx, Connection.tsx, Overview.tsx and ConnectionSection.tsx before).
// The wording stays in the renderer; device-view.test.ts runs these rules through it.
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config'
import { RELAY_FACTS_IDLE } from '@shared/dcs'
import {
  canRecord,
  captureView,
  overviewEndpoint,
  overviewLink,
  captureShown,
  pillEndpoint,
  recordShown,
  relayFacts,
  relayNote,
  relayTip,
  replayView
} from './relay-rules'

const facts = (over: Partial<Parameters<typeof relayFacts>[0]> = {}) =>
  relayFacts({
    config: DEFAULT_CONFIG,
    deviceState: 'no-device',
    linkUp: false,
    recording: { on: false },
    ...over
  })

describe('relayFacts', () => {
  it('the renderer starts from the facts for the default settings, no device, stopped', () => {
    expect(facts()).toEqual(RELAY_FACTS_IDLE)
  })

  it('each side of the on/off: a pending Start reads as running, with the stream not up yet', () => {
    const f = facts({ config: { ...DEFAULT_CONFIG, sourceMode: 'bridge' } })
    expect(f.stopped).toMatchObject({ tip: 'stopped', startBlocked: 'bridge', waiting: 'none' })
    expect(f.running).toMatchObject({ tip: 'waiting-device', waiting: 'device' })
    expect(f.running.startBlocked, 'a running relay is never blocked').toBeUndefined()
    const replay = facts({
      config: { ...DEFAULT_CONFIG, sourceMode: 'replay', replayDriveSerial: true }
    })
    expect(replay.stopped.startBlocked).toBe('replay')
    expect(replay.running.tip).toBe('replay-playing')
  })
})

describe('N3: waiting for the Gateway is Bridge only; a driven Replay is blocked, never waiting', () => {
  it.each(['monitor', 'replay'] as const)('%s, no board, running', (mode) => {
    const o = {
      mode,
      relaying: true,
      stream: 'connected' as const,
      deviceState: 'no-device' as const
    }
    expect(relayNote(o)).toBe('none')
    expect(relayTip(o)).not.toBe('waiting-device')
  })
})

describe('N2: the Overview says "relay waiting" whenever a relay runs with the link down', () => {
  it('in every mode, Monitor included', () => {
    expect(overviewLink(true, false)).toBe('waiting')
    expect(overviewLink(true, true)).toBe('gateway-relaying')
    expect(overviewLink(false, true)).toBe('gateway-stopped')
    expect(overviewLink(false, false)).toBe('stopped')
  })
})

describe('X9: each surface’s own endpoint label', () => {
  it('the pill: host and port as typed, the multicast group, or "unicast listen"', () => {
    expect(pillEndpoint('tcp-to-host')).toEqual({ hostPort: { suffix: '' } })
    expect(pillEndpoint('loopback-multicast')).toEqual({ text: '239.255.50.10:5010' })
    expect(pillEndpoint('unicast-listen')).toEqual({ text: 'unicast listen' })
  })

  it('the Overview: host and port as typed, else the multicast group — for Unicast too', () => {
    expect(overviewEndpoint('tcp-to-host')).toEqual({ hostPort: { suffix: ' · remote' } })
    expect(overviewEndpoint('loopback-multicast')).toEqual({ text: '239.255.50.10:5010 · local' })
    expect(overviewEndpoint('unicast-listen')).toEqual({ text: '239.255.50.10:5010 · local' })
  })
})

describe('X12: each surface’s own Record rule', () => {
  it('the Connection card only while relaying; Settings › Connection whenever', () => {
    expect(canRecord(true)).toEqual({ connection: true, settings: true })
    expect(canRecord(false)).toEqual({ connection: false, settings: true })
  })
})

describe('X12-style: each surface’s own Record visibility (R3.4a)', () => {
  it('the Connection card hidden in Replay; Settings › Connection’s row always shown', () => {
    expect(recordShown('bridge')).toEqual({ connection: true, settings: true })
    expect(recordShown('monitor')).toEqual({ connection: true, settings: true })
    expect(recordShown('replay')).toEqual({ connection: false, settings: true })
    const f = facts({ config: { ...DEFAULT_CONFIG, sourceMode: 'replay' } })
    expect(f.recordShown, 'pushed with the facts, the same for both sides').toEqual({
      connection: false,
      settings: true
    })
  })

  it('the Capture card is the Record card’s mirror, in the same facts', () => {
    for (const mode of ['bridge', 'monitor', 'replay'] as const) {
      expect(captureShown(mode), mode).toBe(mode === 'replay')
      const f = facts({ config: { ...DEFAULT_CONFIG, sourceMode: mode } })
      expect(f.captureShown, mode).toBe(!f.recordShown.connection)
    }
  })
})

describe('the recording and the capture, as the page set them', () => {
  it('from the toggle’s and the open’s answers; a capture that did not load keeps the last', () => {
    expect(captureView({ recording: true, path: '/a' })).toEqual({ on: true, events: undefined })
    expect(captureView({ recording: false, path: '/a', events: 9 })).toEqual({
      on: false,
      events: 9
    })
    const one = replayView(
      { loaded: true, path: '/c/a.skycap', events: 3, durationMs: 1500 },
      undefined
    )
    expect(one).toEqual({ file: '/c/a.skycap', events: 3, durationMs: 1500 })
    expect(replayView({ loaded: false }, one)).toBe(one)
    expect(replayView({ loaded: true, path: '/b' }, one)).toEqual({
      file: '/b',
      events: 0,
      durationMs: 0
    })
  })
})
