// The settings as the forms edit them (pure, no Node/Electron deps): what the renderer's store held
// and rebuilt into a settings save before R3.3 (store.ts buildConfig). Main builds the save now,
// over what it holds; the forms send only what changed (ConfigEdit), the command port as typed.
import type { AppConfig, ConfigEdit } from '@shared/config'
import { parsePsuLimit, type PsuLimits, type PsuSetting } from '@shared/nodes'

/** The edited fields as the settings hold them (the command port as its number). */
export type ConfigForm = Required<Omit<ConfigEdit, 'psuMode' | 'psuLimit' | 'port'>> & {
  commandPort: number
}

/** A form's change once its typed port is read (commandPortOf): the fields, and the PSU switch. */
export type FormEdit = Partial<ConfigForm> & Pick<ConfigEdit, 'psuMode'>

/** What a refused command port says, under the field (N5). */
export const COMMAND_PORT_ERROR = 'Not a port. Enter a whole number from 1 to 65535.'

/**
 * The command port as typed, if it is one: whole digits (spaces around them ignored), 1–65535.
 * Anything else is no port (undefined), and nothing is saved for it (N5).
 */
export function commandPortOf(text: string): number | undefined {
  const t = text.trim()
  if (!/^\d{1,5}$/.test(t)) return undefined
  const n = Number(t)
  return n >= 1 && n <= 65535 ? n : undefined
}

/** The forms' fields as the settings hold them. */
export function formOf(cfg: AppConfig): ConfigForm {
  return {
    sourceMode: cfg.sourceMode,
    transport: cfg.transport,
    host: cfg.host,
    commandPort: cfg.commandPort,
    autoConnect: cfg.autoConnect,
    replayDriveSerial: cfg.replayDriveSerial,
    debugMode: cfg.debugMode,
    attentionBanner: cfg.attentionBanner,
    checkFirmwareOnLaunch: cfg.checkFirmwareOnLaunch,
    psu: cfg.psu
  }
}

/** The settings save the forms make: every field they edit, saved whole. */
export function buildConfig(s: ConfigForm): Partial<AppConfig> {
  return {
    sourceMode: s.sourceMode,
    transport: s.transport,
    host: s.host,
    commandPort: s.commandPort,
    autoConnect: s.autoConnect,
    replayDriveSerial: s.replayDriveSerial,
    debugMode: s.debugMode,
    attentionBanner: s.attentionBanner,
    checkFirmwareOnLaunch: s.checkFirmwareOnLaunch,
    psu: s.psu
  }
}

/**
 * A form's change, read-modify-write: the forms' fields as the settings hold them, the change over
 * them, built into the save (buildConfig). A PSU mode switch keeps the rest of the setting — the
 * preset and the custom limits — as it is (R3.4a: Settings › Cockpit's `{ ...psu, mode }`).
 */
export function editedConfig(current: AppConfig, edit: FormEdit): Partial<AppConfig> {
  const { psuMode: mode, ...fields } = edit
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

/** What a form's change comes to: the save, or why nothing is saved (`error`, for the form). */
export type SavedEdit = { ok: true; save: Partial<AppConfig> } | { ok: false; error?: string }

/**
 * A form's change as SettingsService saves it (`config:edit`): editedConfig, with the typed port
 * read (commandPortOf) and a typed PSU limit applied over the setting held. A port that is not one
 * is refused with its error (N5); a refused PSU limit is refused quietly, as the form sent nothing
 * for it before (its field judges itself). Refused = nothing to save.
 */
export function savedEdit(current: AppConfig, edit: ConfigEdit): SavedEdit {
  const { psuLimit: limit, port, ...rest } = edit
  const fields: FormEdit = rest
  if (port !== undefined) {
    const commandPort = commandPortOf(port)
    if (commandPort === undefined) return { ok: false, error: COMMAND_PORT_ERROR }
    fields.commandPort = commandPort
  }
  if (limit === undefined) return { ok: true, save: editedConfig(current, fields) }
  const psu = withPsuLimit(current.psu, limit.key, limit.text)
  return psu ? { ok: true, save: editedConfig(current, { ...fields, psu }) } : { ok: false }
}
