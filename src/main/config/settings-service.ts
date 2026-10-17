// The app settings (AppConfig): the live copy, and config.json in <userData> so they survive
// restarts. Where that file lives is handed in by app (SettingsPaths): this module never asks
// electron. The file mechanics are the JSON store's (fsync, `.bak`, fallback to it). What a
// problem means here: a tolerant read (a file that cannot be loaded, nor its backup, loads the
// defaults) and a write that never crashes the app nor blocks the change in memory. Either one
// that goes wrong is an event row (SettingsFileEvents), never silent.
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
  type ConfigEditResult,
  type ConfigView,
  type SettingsStore
} from '@shared/config'
import { resolvePsu } from '../nodes'
import { sanitizeConfig } from './settings-schema'
import { savedEdit } from './settings-form'
import { jsonFile, type JsonWriteError } from './json-store'
import { fileErrorText } from '@shared/format'

/** Port: where config.json lives. app provides it; resolved at each use, as before. */
export interface SettingsPaths {
  configFile(): string
}

/**
 * Port: the event log, as config.json reports to it (app wires the EventJournal). `error` is a
 * client error row, deduped per tag; `forget` makes the tag's next error news again.
 */
export interface SettingsFileEvents {
  error(tag: string, message: string): void
  /** The same row at warn: recovered, nothing lost. Same tag and dedupe as `error`. */
  warn(tag: string, message: string): void
  forget(tag: string): void
}

/** The event-log tag of config.json's rows. */
export const CONFIG_FILE_TAG = 'config.json'

const NO_EVENTS: SettingsFileEvents = { error: () => {}, warn: () => {}, forget: () => {} }

const configFile = (paths: SettingsPaths) => jsonFile(() => paths.configFile())

export function loadConfig(paths: SettingsPaths, events = NO_EVENTS): AppConfig {
  try {
    const r = configFile(paths).read()
    switch (r.kind) {
      case 'read':
        return sanitizeConfig(r.data)
      case 'fallback': // loaded from the backup: nothing lost, a warn row
        events.warn(CONFIG_FILE_TAG, r.note)
        return sanitizeConfig(r.data)
      case 'failed':
        events.error(CONFIG_FILE_TAG, `${r.note} Using the default settings.`)
        return { ...DEFAULT_CONFIG }
      case 'missing':
        return { ...DEFAULT_CONFIG }
    }
  } catch {
    // the path could not be resolved (no <userData>): nothing was read
    return { ...DEFAULT_CONFIG }
  }
}

/**
 * Never throws: a read-only userData dir must not crash the app, and the change stays in memory.
 * A failed write is an event row, one per failure until a write succeeds again. Says why, in plain
 * words, when the file did not reach the disk — the reason alone (`permission denied in
 * <folder>`), which a config import puts after its section's title; see `replace`.
 */
export function saveConfig(
  config: AppConfig,
  paths: SettingsPaths,
  events = NO_EVENTS
): string | undefined {
  let failed: JsonWriteError | undefined
  try {
    failed = configFile(paths).write(config)
  } catch (err) {
    // the path could not be resolved (no <userData>): nothing was written
    return fileErrorText(err)
  }
  if (failed) events.error(CONFIG_FILE_TAG, failed.note)
  else events.forget(CONFIG_FILE_TAG)
  return failed && fileErrorText(failed.error)
}

/** What came of `replace`: the settings now live, or why config.json was not written. */
export type SettingsReplace = { ok: true; config: AppConfig } | { ok: false; error: string }

/** A settings store of its own, starting at `initial` (a copy). Not a singleton: each owner builds one. */
function createSettingsStore(initial: AppConfig = DEFAULT_CONFIG) {
  return createStore<AppConfig>()(subscribeWithSelector(() => ({ ...initial })))
}

export interface SettingsServiceDeps {
  paths: SettingsPaths
  /** Where config.json's problems are reported (the event log); none, for a quiet owner. */
  events?: SettingsFileEvents
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
    saveConfig(config, this.deps.paths, this.deps.events)
    if (push) this.changed('edit')
    return config
  }

  /**
   * A form's change (`config:edit`, R3.3): what the renderer's store rebuilt into a save before —
   * read-modify-write over the settings held here, the port as typed (settings-form.ts).
   */
  edit(edit: ConfigEdit): ConfigEditResult {
    const built = savedEdit(this.get(), edit)
    // A refused change saves and pushes nothing: a port that is not one answers why (N5); a
    // refused PSU limit, quietly, as the form sent nothing for it before (R3.4a).
    if (!built.ok) return built
    return { ok: true, config: this.apply(built.save) }
  }

  /**
   * A config import's settings (C2/M10): written to config.json first, and live only once they are
   * on disk, so an import that cannot save them changes nothing here and says why. Not pushed:
   * the import tells the renderer once it is done (imported()). Also its rollback's path.
   */
  replace(config: AppConfig): SettingsReplace {
    const failed = saveConfig(config, this.deps.paths, this.deps.events)
    if (failed !== undefined) return { ok: false, error: failed }
    const live = this.update(config)
    this.deps.debugMode(live.debugMode)
    return { ok: true, config: live }
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
    const cfg = this.update(loadConfig(this.deps.paths, this.deps.events)) // seed from persisted settings
    this.deps.debugMode(cfg.debugMode)
    return cfg
  }
}
