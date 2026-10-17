// The settings as the forms edit them (pure, no Node/Electron deps): what the renderer's store held
// and rebuilt into a settings save before R3.3 (store.ts buildConfig). Main builds the save now,
// over what it holds; the forms send only what changed (ConfigEdit), the command port as typed.
import type { AppConfig, ConfigEdit } from '@shared/config'

/** The edited fields, with the command port as text (what the Connection forms show). */
export type ConfigForm = Required<ConfigEdit>

/** The forms' fields as the settings hold them: the port as its digits. */
export function formOf(cfg: AppConfig): ConfigForm {
  return {
    sourceMode: cfg.sourceMode,
    transport: cfg.transport,
    host: cfg.host,
    port: String(cfg.commandPort),
    autoConnect: cfg.autoConnect,
    replayDriveSerial: cfg.replayDriveSerial,
    debugMode: cfg.debugMode,
    attentionBanner: cfg.attentionBanner,
    psu: cfg.psu
  }
}

/**
 * The settings save the forms make: every field they edit, saved whole. A port that isn't a
 * number, or is empty, saves as 7778 — while the field keeps showing what was typed (N5).
 */
export function buildConfig(s: ConfigForm): Partial<AppConfig> {
  return {
    sourceMode: s.sourceMode,
    transport: s.transport,
    host: s.host,
    commandPort: Number(s.port) || 7778,
    autoConnect: s.autoConnect,
    replayDriveSerial: s.replayDriveSerial,
    debugMode: s.debugMode,
    attentionBanner: s.attentionBanner,
    psu: s.psu
  }
}

/**
 * A form's change, read-modify-write: the forms' fields as the settings hold them, the change over
 * them, built into the save (buildConfig).
 */
export function editedConfig(current: AppConfig, edit: ConfigEdit): Partial<AppConfig> {
  return buildConfig({ ...formOf(current), ...edit })
}
