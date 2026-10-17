// Relay rules (pure, no Node/Electron deps): which way the stream goes in each source mode, and
// which settings a running relay is built from.
import type { AppConfig } from '@shared/config'

/** Settings a running relay is built from. Changing anything else must not restart it. */
export const RELAY_KEYS = [
  'sourceMode',
  'transport',
  'host',
  'commandPort',
  'listenPort',
  'replayDriveSerial'
] as const satisfies readonly (keyof AppConfig)[]

/** The settings the relay reads: exactly the ones it is built from (RELAY_KEYS). */
export type RelayOptions = Pick<AppConfig, (typeof RELAY_KEYS)[number]>

type ForwardConfig = Pick<RelayOptions, 'sourceMode' | 'replayDriveSerial'>

/**
 * Whether the export stream is written to the SimGateway — and so whether Start needs the board.
 *
 * Bridge always; Replay only with "Drive SimGateway"; Monitor never. Monitor has to say so
 * explicitly now that the port is open in every mode — before #69 it was read-only only because
 * it had no port to write to.
 */
export function exportToDevice(cfg: ForwardConfig): boolean {
  return cfg.sourceMode === 'bridge' || (cfg.sourceMode === 'replay' && cfg.replayDriveSerial)
}

/** Whether device traffic goes on to DCS: only a running Bridge relay has a DCS to send it to. */
export function deviceToDcs(cfg: ForwardConfig, running: boolean): boolean {
  return running && cfg.sourceMode === 'bridge'
}

export function relayConfigChanged<T extends RelayOptions>(prev: T, next: T): boolean {
  return RELAY_KEYS.some((k) => prev[k] !== next[k])
}
