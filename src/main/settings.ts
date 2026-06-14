// Persist AppConfig to <userData>/config.json so settings survive restarts.
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONFIG, sanitizeConfig, type AppConfig } from '@shared/ipc'

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

export function loadConfig(): AppConfig {
  try {
    const p = configPath()
    if (!existsSync(p)) return { ...DEFAULT_CONFIG }
    return sanitizeConfig(JSON.parse(readFileSync(p, 'utf8')))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(config: AppConfig): void {
  try {
    writeFileSync(configPath(), JSON.stringify(config, null, 2))
  } catch {
    // best-effort; a read-only userData dir shouldn't crash the app
  }
}
