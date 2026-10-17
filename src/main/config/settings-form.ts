// The settings as the forms edit them (pure, no Node/Electron deps): what the renderer's store held
// and rebuilt into a settings save before R3.3 (store.ts buildConfig). Main builds the save now,
// over what it holds; the forms send only what changed (ConfigEdit), the command port as typed.
import type { AppConfig, ConfigEdit } from '@shared/config'
import { parsePsuLimit, type PsuLimits, type PsuSetting } from '@shared/nodes'

/** The edited fields, with the command port as text (what the Connection forms show). */
export type ConfigForm = Required<Omit<ConfigEdit, 'psuMode' | 'psuLimit'>>

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
 * them, built into the save (buildConfig). A PSU mode switch keeps the rest of the setting — the
 * preset and the custom limits — as it is (R3.4a: Settings › Cockpit's `{ ...psu, mode }`).
 */
export function editedConfig(current: AppConfig, edit: ConfigEdit): Partial<AppConfig> {
  const { psuMode: mode, psuLimit: _limit, ...fields } = edit
  const form = { ...formOf(current), ...fields }
  return buildConfig(mode === undefined ? form : { ...form, psu: { ...form.psu, mode } })
}

/**
 * One PSU limit as typed, over the setting (R3.4a: Settings › Cockpit's onType before). A value
 * that is not a limit is refused (undefined: nothing is saved); empty removes the limit; anything
 * else sets it. The field keeps showing what was typed either way: that text is the form's.
 */
export function withPsuLimit(
  psu: PsuSetting,
  k: keyof PsuLimits,
  text: string
): PsuSetting | undefined {
  const n = parsePsuLimit(text)
  if (n === null) return undefined
  const custom = { ...psu.custom }
  if (n === undefined) delete custom[k]
  else custom[k] = n
  return { ...psu, custom }
}

/**
 * A form's change as SettingsService saves it (`config:edit`): editedConfig, with a typed PSU limit
 * applied over the setting held. undefined = refused, nothing to save — as the form sent nothing
 * for it before.
 */
export function savedEdit(current: AppConfig, edit: ConfigEdit): Partial<AppConfig> | undefined {
  const { psuLimit: limit, ...rest } = edit
  if (limit === undefined) return editedConfig(current, rest)
  const psu = withPsuLimit(current.psu, limit.key, limit.text)
  return psu && editedConfig(current, { ...rest, psu })
}
