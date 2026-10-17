import { describe, expect, it } from 'vitest'
import { DEVICE_IDLE, type DeviceState } from '@shared/gateway'
import {
  isBoardPresent,
  isBusy,
  isLinkUp,
  linkAction,
  LinkDownClock,
  linkFacts
} from './link-state'

const STATES: DeviceState[] = [
  'connected',
  'scanning',
  'reconnecting',
  'no-device',
  'disconnected',
  'error'
]

describe('link facts (R3.3: decided here, pushed on device:status)', () => {
  it('up only while connected; the board present while connected, erroring or released', () => {
    expect(STATES.filter(isLinkUp)).toEqual(['connected'])
    expect(STATES.filter(isBoardPresent)).toEqual(['connected', 'disconnected', 'error'])
  })

  it('names another program holding the port as busy', () => {
    for (const d of ['Resource busy', 'Access denied', 'port in use', 'ACCESS']) {
      expect(isBusy(d), d).toBe(true)
    }
    for (const d of [undefined, '', 'EIO', 'Port not found']) expect(isBusy(d), d).toBe(false)
  })

  it('the renderer starts from the idle facts: no device, nothing concluded', () => {
    const idle = { state: 'no-device' as const }
    expect({ ...idle, ...linkFacts(idle, { serialMonitor: false }) }).toEqual(DEVICE_IDLE)
  })
})

describe('the Cockpit’s "last known" time (store.ts before R3.3)', () => {
  it('stamped on an up → down push only, cleared while up, kept otherwise', () => {
    let now = 1000
    const clock = new LinkDownClock(() => now)
    expect(clock.pushed('scanning')).toBeUndefined()
    expect(clock.pushed('connected')).toBeUndefined()
    now = 2000
    expect(clock.pushed('reconnecting')).toBe(2000)
    now = 3000
    expect(clock.pushed('no-device'), 'only the up → down transition sets it').toBe(2000)
    expect(clock.pushed('connected')).toBeUndefined()
    // A push that changes nothing about the link (the Gateway's health) keeps it.
    now = 4000
    expect(clock.pushed('disconnected')).toBe(4000)
    expect(clock.pushed('disconnected')).toBe(4000)
  })

  it('a reloaded page has none until the link next drops (N1)', () => {
    let now = 1000
    const clock = new LinkDownClock(() => now)
    clock.pushed('connected')
    clock.pushed('reconnecting')
    expect(clock.value).toBe(1000)
    clock.pageLoaded('reconnecting')
    expect(clock.value).toBeUndefined()
    now = 2000
    expect(clock.pushed('no-device'), 'down → down is no drop').toBeUndefined()
    expect(clock.pushed('connected')).toBeUndefined()
    expect(clock.pushed('reconnecting')).toBe(2000)
    // Reloaded while up: the next drop stamps.
    clock.pushed('connected')
    clock.pageLoaded('connected')
    now = 3000
    expect(clock.pushed('error')).toBe(3000)
  })
})

describe('the link’s action (R3.4a: the renderer’s deviceView table before)', () => {
  it('Connect when released, Retry on error, Disconnect otherwise — not while mid-open', () => {
    expect(Object.fromEntries(STATES.map((s) => [s, linkAction(s)]))).toEqual({
      connected: { offer: 'disconnect', intent: 'disconnect' },
      scanning: { offer: 'disconnect', intent: 'disconnect', disabled: true },
      reconnecting: { offer: 'disconnect', intent: 'disconnect' },
      'no-device': { offer: 'disconnect', intent: 'disconnect' },
      disconnected: { offer: 'connect', intent: 'connect' },
      error: { offer: 'retry', intent: 'connect' }
    })
  })

  it('every push carries it, and nothing for Refresh (#132: the button is gone)', () => {
    const up = { state: 'connected' as const }
    expect(linkFacts(up, { serialMonitor: false })).toMatchObject({
      action: { offer: 'disconnect', intent: 'disconnect' }
    })
    expect(linkFacts(up, { serialMonitor: false })).not.toHaveProperty('canRefresh')
  })
})
