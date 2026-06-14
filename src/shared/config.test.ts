import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, sanitizeConfig } from './ipc'

describe('sanitizeConfig', () => {
  it('falls back to defaults for empty / junk input', () => {
    expect(sanitizeConfig({})).toEqual(DEFAULT_CONFIG)
    expect(sanitizeConfig(null)).toEqual(DEFAULT_CONFIG)
    expect(sanitizeConfig('nope')).toEqual(DEFAULT_CONFIG)
  })

  it('keeps valid values and rejects invalid enums / types', () => {
    const out = sanitizeConfig({
      sourceMode: 'bridge',
      transport: 'loopback-multicast',
      host: '192.168.1.10',
      commandPort: 7778,
      listenPort: 5010,
      autoReconnect: false,
      replayDriveSerial: true,
      debugMode: true
    })
    expect(out).toEqual({
      sourceMode: 'bridge',
      transport: 'loopback-multicast',
      host: '192.168.1.10',
      commandPort: 7778,
      listenPort: 5010,
      autoReconnect: false,
      replayDriveSerial: true,
      debugMode: true
    })
  })

  it('coerces bad enum / port back to defaults', () => {
    const out = sanitizeConfig({
      sourceMode: 'hacked',
      transport: 'x',
      commandPort: 'NaN',
      host: ''
    })
    expect(out.sourceMode).toBe(DEFAULT_CONFIG.sourceMode)
    expect(out.transport).toBe(DEFAULT_CONFIG.transport)
    expect(out.commandPort).toBe(DEFAULT_CONFIG.commandPort)
    expect(out.host).toBe(DEFAULT_CONFIG.host)
  })
})
