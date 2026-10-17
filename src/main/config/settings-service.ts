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
import type { Emit } from '@shared/app'
import {
  DEFAULT_CONFIG,
  type AppConfig,
  type ConfigChanged,
  type ConfigEdit,
  type ConfigView,
  type SettingsStore
} from '@shared/config'
import { resolvePsu } from '../nodes'
import { sanitizeConfig } from './settings-schema'
import { savedEdit } from './settings-form'
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
function createSettingsStore(initial: AppConfig = DEFAULT_CONFIG) {
  return createStore<AppConfig>()(subscribeWithSelector(() => ({ ...initial })))
}

export interface SettingsServiceDeps {
  paths: SettingsPaths
  /** The debug log's switch (app's debug-log), set from each applied or loaded config. */
  debugMode(on: boolean): void
  /** The renderer push (`config:changed`, R3.3); none, for an owner that only stores settings. */
  emit?: Emit<'config:changed'>
}

export class SettingsService {
  private readonly live = createSettingsStore()

  /** The live settings, read-only: the one instance every settings reader is handed. */
  readonly store: SettingsStore = this.live

  constructor(private readonly deps: SettingsServiceDeps) {}

  get(): AppConfig {
    return this.live.getState()
  }

  /** The settings and what they resolve to (`config:get`, R3.3). */
  view(): ConfigView {
    const config = this.get()
    return { config, psu: resolvePsu(config.psu) }
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

  /**
   * Apply and persist a settings change: the one path for config:set, a form's edit and a config
   * import. The renderer is told (`config:changed`) unless `push` is off — an import tells it once
   * it is done (imported()).
   */
  apply(patch: Partial<AppConfig>, push = true): AppConfig {
    const config = this.update(patch)
    this.deps.debugMode(config.debugMode)
    saveConfig(config, this.deps.paths)
    if (push) this.changed('edit')
    return config
  }

  /**
   * A form's change (`config:edit`, R3.3): what the renderer's store rebuilt into a save before —
   * read-modify-write over the settings held here, the port as typed (settings-form.ts).
   */
  edit(edit: ConfigEdit): AppConfig {
    const save = savedEdit(this.get(), edit)
    // A refused PSU limit saves and pushes nothing: the form sent nothing for it before (R3.4a).
    return save === undefined ? this.get() : this.apply(save)
  }

  /** A config import is applied: the forms start over from the settings, as from its answer. */
  imported(): void {
    this.changed('import')
  }

  private changed(source: ConfigChanged['source']): void {
    this.deps.emit?.('config:changed', { ...this.view(), source })
  }

  /** App launch: seed from config.json. Not written back. */
  load(): AppConfig {
    const cfg = this.update(loadConfig(this.deps.paths)) // seed from persisted settings
    this.deps.debugMode(cfg.debugMode)
    return cfg
  }
}
