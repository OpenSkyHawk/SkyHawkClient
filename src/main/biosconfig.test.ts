import { describe, expect, it } from 'vitest'
import { parseBiosConfig, isLoopbackExport } from './biosconfig'

const LUA = `
BIOSConfig = {}
tcp_config = {{ address = "*", port = 7778 }}
udp_config = {{ receive_address = "*", receive_port = 7778, send_address = "239.255.50.10", send_port = 5010 }}
`

describe('parseBiosConfig', () => {
  it('reads tcp + udp config', () => {
    const cfg = parseBiosConfig(LUA)
    expect(cfg.tcp).toEqual({ address: '*', port: 7778 })
    expect(cfg.udp).toEqual({
      receiveAddress: '*',
      receivePort: 7778,
      sendAddress: '239.255.50.10',
      sendPort: 5010
    })
  })

  it('flags the default multicast export as loopback-only', () => {
    expect(isLoopbackExport(parseBiosConfig(LUA))).toBe(true)
  })

  it('treats a unicast send_address as remote-reachable', () => {
    const cfg = parseBiosConfig(
      'udp_config = {{ send_address = "192.168.1.50", send_port = 5010 }}'
    )
    expect(isLoopbackExport(cfg)).toBe(false)
  })

  it('returns empty when no blocks present', () => {
    expect(parseBiosConfig('-- nothing here')).toEqual({})
  })
})
