// Persist AppConfig to <userData>/config.json so settings survive restarts.
// Where that file lives is handed in by app (SettingsPaths): this module never asks electron.
// The file mechanics are the JSON store's, under config.json's policy: a tolerant read (anything
// wrong loads the defaults) and a best-effort write.
import { DEFAULT_CONFIG, type AppConfig } from '@shared/config'
import { sanitizeConfig } from './settings-schema'
import { JSON_POLICY, jsonFile } from './json-store'

/** Port: where config.json lives. app provides it; resolved at each use, as before. */
export interface SettingsPaths {
  configFile(): string
}

const configFile = (paths: SettingsPaths) => jsonFile(() => paths.configFile(), JSON_POLICY.config)

export function loadConfig(paths: SettingsPaths): AppConfig {
  try {
    const r = configFile(paths).read()
    return r.kind === 'read' ? sanitizeConfig(r.data) : { ...DEFAULT_CONFIG }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/** Best effort (the policy swallows a failure): a read-only userData dir shouldn't crash the app. */
export function saveConfig(config: AppConfig, paths: SettingsPaths): void {
  configFile(paths).write(config)
}
