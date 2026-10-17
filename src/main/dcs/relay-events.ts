// Relay events (pure, no Node/Electron deps): the event-log rows the relay and the DCS-BIOS stream
// make as they start, stop, come up and drop.
import type { AppConfig, SourceMode } from '@shared/config'
import { EXPORT_MULTICAST_ADDR, EXPORT_PORT, type RelayState } from '@shared/dcs'
import type { LogEventInput } from '@shared/events'

export interface RelayContext {
  mode: SourceMode
  /** Where the DCS-BIOS stream comes from, e.g. `127.0.0.1:7778`. */
  endpoint: string
  /** TCP connects; UDP only binds, so "connected" there is "listening". */
  tcp: boolean
}

/** Where the stream comes from, for the relay's event-log rows. */
export function relayContext(
  cfg: Pick<AppConfig, 'sourceMode' | 'transport' | 'host' | 'commandPort' | 'listenPort'>
): RelayContext {
  const tcp = cfg.transport === 'tcp-to-host'
  const endpoint = tcp
    ? `${cfg.host}:${cfg.commandPort}`
    : cfg.transport === 'loopback-multicast'
      ? `${EXPORT_MULTICAST_ADDR}:${EXPORT_PORT}`
      : `:${cfg.listenPort}`
  return { mode: cfg.sourceMode, endpoint, tcp }
}

const MODE_LABEL: Record<SourceMode, string> = {
  bridge: 'Bridge mode',
  monitor: 'Monitor mode',
  replay: 'Replay'
}

/**
 * Relay started / stopped, and the DCS-BIOS stream coming up or dropping while it runs. A stream
 * error is not repeated here: the transport's own error already makes a `DCS` row, and the
 * reconnect attempts that follow it are not rows either.
 */
export function relayEvents(
  prev: RelayState,
  next: RelayState,
  ctx: RelayContext,
  now: number
): LogEventInput[] {
  const relay = { t: now, source: 'client' as const, name: 'Relay' }
  const dcs = { t: now, source: 'client' as const, name: 'DCS' }
  const out: LogEventInput[] = []
  if (!prev.running && next.running) {
    out.push({
      ...relay,
      severity: 'info',
      event: 'started',
      detail: MODE_LABEL[ctx.mode],
      raw: `relay: start (${ctx.mode})`
    })
  } else if (prev.running && !next.running) {
    out.push({ ...relay, severity: 'info', event: 'stopped', raw: 'relay: stop' })
  }
  if (!next.running || prev.stream === next.stream) return out
  if (ctx.mode === 'replay') {
    if (next.stream === 'ended') {
      out.push({ ...relay, severity: 'info', event: 'replay ended', raw: 'relay: replay ended' })
    }
  } else if (next.stream === 'connected') {
    out.push({
      ...dcs,
      severity: 'info',
      event: ctx.tcp ? 'link up' : 'listening',
      detail: ctx.endpoint,
      raw: `DCS: connected ${ctx.endpoint}`
    })
  } else if (next.stream === 'reconnecting' && prev.stream === 'connected') {
    // Only a link that was up dropping: retries after an error are that error's row, once.
    out.push({
      ...dcs,
      severity: 'warn',
      event: 'reconnecting',
      detail: ctx.endpoint,
      raw: `DCS: reconnecting ${ctx.endpoint}`
    })
  }
  return out
}
