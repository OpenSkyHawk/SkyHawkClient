// The settings schema: coerces whatever config.json holds into a valid AppConfig. The shape and its
// defaults are the config contract (shared/config/ipc.ts); this is the rule that reads it back.
import {
  DEFAULT_CONFIG,
  SOURCE_MODES,
  TRANSPORTS,
  type AppConfig,
  type DcsTransport,
  type SourceMode
} from '@shared/config'
import { sanitizePsu } from '../nodes'

/** Coerce arbitrary (e.g. persisted/untrusted) data into a valid AppConfig. */
export function sanitizeConfig(raw: unknown): AppConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppConfig>
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  return {
    sourceMode: SOURCE_MODES.includes(r.sourceMode as SourceMode)
      ? (r.sourceMode as SourceMode)
      : DEFAULT_CONFIG.sourceMode,
    transport: TRANSPORTS.includes(r.transport as DcsTransport)
      ? (r.transport as DcsTransport)
      : DEFAULT_CONFIG.transport,
    host: typeof r.host === 'string' && r.host ? r.host : DEFAULT_CONFIG.host,
    commandPort: num(r.commandPort, DEFAULT_CONFIG.commandPort),
    listenPort: num(r.listenPort, DEFAULT_CONFIG.listenPort),
    // The old `autoReconnect` is not carried over: it governed reopen-after-drop for a link that
    // only existed while relaying, and connecting by default is the intended behaviour now.
    autoConnect: typeof r.autoConnect === 'boolean' ? r.autoConnect : DEFAULT_CONFIG.autoConnect,
    replayDriveSerial:
      typeof r.replayDriveSerial === 'boolean'
        ? r.replayDriveSerial
        : DEFAULT_CONFIG.replayDriveSerial,
    debugMode: typeof r.debugMode === 'boolean' ? r.debugMode : DEFAULT_CONFIG.debugMode,
    attentionBanner:
      typeof r.attentionBanner === 'boolean' ? r.attentionBanner : DEFAULT_CONFIG.attentionBanner,
    psu: sanitizePsu(r.psu)
  }
}
