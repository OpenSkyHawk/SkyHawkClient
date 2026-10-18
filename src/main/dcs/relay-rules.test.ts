// R3.3: what the relay's surfaces show, decided here and pushed on relay:facts (the renderer
// decided them before). The wording stays in the renderer; gateway/link-view.test.ts runs these
// rules through it.
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config'
import { RELAY_FACTS_IDLE } from '@shared/dcs'
import {
  canRecord,
  captureView,
  overviewLink,
  captureShown,
  recordShown,
  relayEndpoint,
  relayFacts,
  relayNote,
  relayTip,
  relayWaiting,
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
    expect(replay.running.tip, 'a driven Replay waits for the board (N3)').toBe('waiting-device')
    const undriven = facts({ config: { ...DEFAULT_CONFIG, sourceMode: 'replay' } })
    expect(undriven.running.tip).toBe('replay-playing')
  })

  it('carries the mode and the transport it was judged against (R3.4c)', () => {
    const f = facts({
      config: { ...DEFAULT_CONFIG, sourceMode: 'replay', transport: 'unicast-listen' }
    })
    expect(f).toMatchObject({ mode: 'replay', transport: 'unicast-listen', captureShown: true })
    expect(f.endpoint).toBe(relayEndpoint({ ...DEFAULT_CONFIG, transport: 'unicast-listen' }))
  })
})

describe('N3: waiting for the Gateway — Bridge and a driven Replay', () => {
  const run = (mode: 'bridge' | 'monitor' | 'replay', replayDriveSerial: boolean) => ({
    mode,
    replayDriveSerial,
    relaying: true,
    stream: 'connected' as const,
    deviceState: 'no-device' as const
  })

  it.each([
    ['bridge', false],
    ['replay', true]
  ] as const)('%s (drive %s), no board, running: the waiting reason', (mode, drive) => {
    const o = run(mode, drive)
    expect(relayNote(o)).toBe('device')
    expect(relayTip(o)).toBe('waiting-device')
    expect(relayWaiting(o)).toBe(true)
  })

  it.each([
    ['monitor', false],
    ['monitor', true],
    ['replay', false]
  ] as const)('%s (drive %s), no board, running: never waiting for it', (mode, drive) => {
    const o = run(mode, drive)
    expect(relayNote(o)).toBe('none')
    expect(relayTip(o)).not.toBe('waiting-device')
    expect(relayWaiting(o)).toBe(false)
  })

  it('a driven Replay with the board up plays on', () => {
    expect(relayTip({ ...run('replay', true), deviceState: 'connected' })).toBe('replay-playing')
  })
})

describe('N2: the Overview says "relay waiting" only while the relay waits for the board', () => {
  const o = (
    mode: 'bridge' | 'monitor' | 'replay',
    relaying: boolean,
    replayDriveSerial = false
  ) => ({
    mode,
    replayDriveSerial,
    relaying,
    stream: 'connected' as const,
    deviceState: 'no-device' as const
  })

  it('Bridge and a driven Replay wait; Monitor and an undriven Replay just run', () => {
    expect(overviewLink(o('bridge', true), false)).toBe('waiting')
    expect(overviewLink(o('replay', true, true), false)).toBe('waiting')
    expect(overviewLink(o('monitor', true), false)).toBe('running')
    expect(overviewLink(o('replay', true), false)).toBe('running')
  })

  it('stopped, or with the link up, the same in every mode', () => {
    for (const mode of ['bridge', 'monitor', 'replay'] as const) {
      expect(overviewLink(o(mode, false), false), mode).toBe('stopped')
      expect(overviewLink(o(mode, false), true), mode).toBe('gateway-stopped')
      expect(overviewLink(o(mode, true), true), mode).toBe('gateway-relaying')
    }
  })

  it('pushed in the facts: Monitor running with no board is not waiting', () => {
    expect(facts().running.overviewLink).toBe('running')
    const bridge = facts({ config: { ...DEFAULT_CONFIG, sourceMode: 'bridge' } })
    expect(bridge.running.overviewLink).toBe('waiting')
  })
})

describe('X9: one endpoint label, right for each transport', () => {
  const at = (transport: (typeof DEFAULT_CONFIG)['transport']) =>
    relayEndpoint({ transport, host: '10.0.0.7', commandPort: 7779, listenPort: 5011 })

  it('TCP: the host and command port; Multicast: the group; Unicast: the port it listens on', () => {
    expect(at('tcp-to-host')).toBe('10.0.0.7:7779')
    expect(at('loopback-multicast')).toBe('239.255.50.10:5010')
    expect(at('unicast-listen')).toBe('this PC:5011')
  })

  it('pushed once in the facts, from the settings held', () => {
    const f = facts({ config: { ...DEFAULT_CONFIG, host: '10.0.0.7', commandPort: 7779 } })
    expect(f.endpoint).toBe('10.0.0.7:7779')
  })
})

describe('X12: Record only while relaying, on every surface', () => {
  it('a recording starts only while relaying; one already on can always be stopped', () => {
    expect(canRecord(true, false)).toBe(true)
    expect(canRecord(false, false)).toBe(false)
    expect(canRecord(false, true)).toBe(true)
    const f = facts()
    expect([f.running.canRecord, f.stopped.canRecord]).toEqual([true, false])
    const on = facts({ recording: { on: true } })
    expect(on.stopped.canRecord, 'a relay stopped mid-recording can still stop it').toBe(true)
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
