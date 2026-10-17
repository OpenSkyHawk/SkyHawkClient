// Persist AppConfig to <userData>/config.json so settings survive restarts.
// Where that file lives is handed in by app (SettingsPaths): this module never asks electron.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { DEFAULT_CONFIG, type AppConfig } from '@shared/config'
import { sanitizeConfig } from './settings-schema'

/** Port: where config.json lives. app provides it; resolved at each use, as before. */
export interface SettingsPaths {
  configFile(): string
}

export function loadConfig(paths: SettingsPaths): AppConfig {
  try {
    const p = paths.configFile()
    if (!existsSync(p)) return { ...DEFAULT_CONFIG }
    return sanitizeConfig(JSON.parse(readFileSync(p, 'utf8')))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(config: AppConfig, paths: SettingsPaths): void {
  try {
    writeFileSync(paths.configFile(), JSON.stringify(config, null, 2))
  } catch {
    // best-effort; a read-only userData dir shouldn't crash the app
  }
}
