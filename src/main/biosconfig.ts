// Convenience discovery: read the user's DCS-BIOS BIOSConfig.lua to learn the
// configured export/command addresses (and warn when a remote setup needs an
// edit). Not required for the TCP path — purely an auto-fill helper. Pure text
// parsing so it is unit-testable without a filesystem.

export interface BiosConfig {
  tcp?: { address?: string; port?: number }
  udp?: {
    receiveAddress?: string
    receivePort?: number
    sendAddress?: string
    sendPort?: number
  }
}

function matchStr(text: string, block: string, key: string): string | undefined {
  const re = new RegExp(`${block}[\\s\\S]*?${key}\\s*=\\s*"([^"]*)"`)
  return re.exec(text)?.[1]
}

function matchNum(text: string, block: string, key: string): number | undefined {
  const re = new RegExp(`${block}[\\s\\S]*?${key}\\s*=\\s*(\\d+)`)
  const m = re.exec(text)
  return m ? Number(m[1]) : undefined
}

export function parseBiosConfig(text: string): BiosConfig {
  const cfg: BiosConfig = {}

  if (/tcp_config/.test(text)) {
    cfg.tcp = {
      address: matchStr(text, 'tcp_config', 'address'),
      port: matchNum(text, 'tcp_config', 'port')
    }
  }
  if (/udp_config/.test(text)) {
    cfg.udp = {
      receiveAddress: matchStr(text, 'udp_config', 'receive_address'),
      receivePort: matchNum(text, 'udp_config', 'receive_port'),
      sendAddress: matchStr(text, 'udp_config', 'send_address'),
      sendPort: matchNum(text, 'udp_config', 'send_port')
    }
  }
  return cfg
}

/**
 * True when the export multicast is loopback-only (default), so a *remote* DCS
 * needs either the TCP transport or a unicast `send_address` edit to reach this host.
 */
export function isLoopbackExport(cfg: BiosConfig): boolean {
  const addr = cfg.udp?.sendAddress
  return !!addr && (addr.startsWith('239.') || addr === '127.0.0.1')
}
