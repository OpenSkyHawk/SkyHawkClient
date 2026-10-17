// The app settings (AppConfig): the live copy, and config.json in <userData> so they survive
// restarts. Where that file lives is handed in by app (SettingsPaths): this module never asks
// electron. The file mechanics are the JSON store's, under config.json's policy: a tolerant read
// (anything wrong loads the defaults) and a best-effort write.
//
// The live copy is one zustand/vanilla store under `subscribeWithSelector`. SettingsService owns
// it and hands out the read-only view (`store`); the services that read settings are given that
// same instance, and read it with `getState()` and react with `subscribe(selector, listener)`.
// Subscribers run synchronously, inside the change, in the order they subscribed.
import { createStore } from 'zustand/vanilla'
import { subscribeWithSelector } from 'zustand/middleware'
import { DEFAULT_CONFIG, type AppConfig, type SettingsStore } from '@shared/config'
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

/** A settings store of its own, starting at `initial` (a copy). Not a singleton: each owner builds one. */
export function createSettingsStore(initial: AppConfig = DEFAULT_CONFIG) {
  return createStore<AppConfig>()(subscribeWithSelector(() => ({ ...initial })))
}

export interface SettingsServiceDeps {
  paths: SettingsPaths
  /** The debug log's switch (app's debug-log), set from each applied or loaded config. */
  debugMode(on: boolean): void
}

export class SettingsService {
  private readonly live = createSettingsStore()

  /** The live settings, read-only: the one instance every settings reader is handed. */
  readonly store: SettingsStore = this.live

  constructor(private readonly deps: SettingsServiceDeps) {}

  get(): AppConfig {
    return this.live.getState()
  }

  /**
   * Merge a change into the live settings. The store's subscribers react inside the call, with
   * the new and the previous settings; nothing is saved.
   */
  update(patch: Partial<AppConfig>): AppConfig {
    const prev = this.live.getState()
    // Replaced, not merged by zustand: the new settings are exactly `{ ...prev, ...patch }`.
    this.live.setState({ ...prev, ...patch }, true)
    return this.live.getState()
  }

  /** Apply and persist a settings change: the one path for config:set and a config import. */
  apply(patch: Partial<AppConfig>): AppConfig {
    const config = this.update(patch)
    this.deps.debugMode(config.debugMode)
    saveConfig(config, this.deps.paths)
    return config
  }

  /** App launch: seed from config.json. Not written back. */
  load(): AppConfig {
    const cfg = this.update(loadConfig(this.deps.paths)) // seed from persisted settings
    this.deps.debugMode(cfg.debugMode)
    return cfg
  }
}
