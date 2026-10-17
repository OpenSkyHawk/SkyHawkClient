// Config topic contract (arch-phase0-v2 §2.3): the app settings, their defaults, and configuration
// export / import (#67). Imported by main, preload and the renderer.
import { COMMAND_PORT, EXPORT_PORT, type DcsTransport, type SourceMode } from '../dcs/ipc'
import {
  DEFAULT_PSU,
  type NodeMappingFile,
  type PsuLimits,
  type PsuPreset,
  type PsuSetting
} from '../nodes/ipc'
import type { CalCache } from '../hid/calibration/ipc'

// Declared beside the relay's facts, which carry both (R3.4c); settings keep exporting them.
export type { DcsTransport, SourceMode }

export const SOURCE_MODES: SourceMode[] = ['bridge', 'monitor', 'replay']
export const TRANSPORTS: DcsTransport[] = ['loopback-multicast', 'unicast-listen', 'tcp-to-host']

export interface AppConfig {
  sourceMode: SourceMode
  transport: DcsTransport
  host: string
  commandPort: number
  listenPort: number // unicast-listen bind port
  /**
   * Open the SimGateway on launch and on plug-in, and reopen it after a drop (#69). Off: the
   * client never takes the port on its own — for anyone sharing it with socat or similar — and
   * the link opens only on an explicit connect.
   */
  autoConnect: boolean
  replayDriveSerial: boolean // Replay mode: also write the replayed export to the SimGateway
  debugMode: boolean // write diagnostics (serial enumeration, device events) to a local log file
  /** Show board-reported problems on the Overview tab (#65). Settings › Cockpit (#67). */
  attentionBanner: boolean
  /** Power supply limits for the Cockpit headroom (#63). Settings › Cockpit (#67). */
  psu: PsuSetting
}

export const DEFAULT_CONFIG: AppConfig = {
  sourceMode: 'monitor',
  transport: 'tcp-to-host',
  host: '127.0.0.1',
  commandPort: COMMAND_PORT,
  listenPort: EXPORT_PORT,
  autoConnect: true,
  replayDriveSerial: false,
  debugMode: false,
  attentionBanner: true,
  psu: DEFAULT_PSU
}

/**
 * A change to the settings as the forms make it (R3.3): the fields they edit, the command port as
 * typed. Main builds the settings from it (buildConfig: a port that isn't a number saves as the
 * default, N5) over what it holds, and saves them.
 */
export interface ConfigEdit {
  sourceMode?: SourceMode
  transport?: DcsTransport
  host?: string
  /** The command port as typed, e.g. `'7778'`, `''` or `'77a'`. */
  port?: string
  autoConnect?: boolean
  replayDriveSerial?: boolean
  debugMode?: boolean
  attentionBanner?: boolean
  psu?: PsuSetting
  /**
   * Settings › Cockpit's PSU switch (R3.4a): main switches the mode over the setting it holds,
   * keeping the preset and the custom limits as they are.
   */
  psuMode?: PsuSetting['mode']
  /**
   * Settings › Cockpit's PSU limit field, as typed (R3.4a): main refuses it (nothing saved), deletes
   * the limit (empty) or sets it, over the setting it holds (settings-form.ts withPsuLimit).
   */
  psuLimit?: { key: keyof PsuLimits; text: string }
}

/** What the power supply setting comes to (R3.3): SettingsService resolves it. */
export interface PsuView {
  /** The plan's PSU box: the preset's model, or plain `PSU` for a custom supply. */
  name: string
  /** The limits the Cockpit draws against: the preset's, or what was entered. */
  limits: PsuLimits
  /** The picked preset (its label, name and read-only limits). */
  preset: PsuPreset
}

/** The settings and what they resolve to: `config:get`, and every `config:changed`. */
export interface ConfigView {
  config: AppConfig
  psu: PsuView
}

/**
 * `config:changed`: main pushes the settings after each change. `import`: an import replaced them,
 * and the forms start over from them, as they did from the import's answer; `edit`: a form's own
 * change came back, which leaves what is typed alone.
 */
export interface ConfigChanged extends ConfigView {
  source: 'edit' | 'import'
}

/** The default power supply as main resolves it: what the renderer holds before it has asked. */
export const PSU_VIEW_DEFAULT: PsuView = {
  name: 'NX650',
  limits: { a12: 54, a5: 20, w: 650 },
  preset: { label: 'NX650', name: 'GOLDEN FIELD NX650', limits: { a12: 54, a5: 20, w: 650 } }
}

/**
 * A read-only view of the settings: the current value and change subscriptions, by selector.
 *
 * Type-only, shaped like zustand/vanilla's `StoreApi` under the `subscribeWithSelector` middleware
 * (`getState` + both `subscribe` overloads), so such a store can be handed out as one.
 */
export interface SettingsStore {
  getState(): AppConfig
  subscribe: {
    (listener: (selectedState: AppConfig, previousSelectedState: AppConfig) => void): () => void
    <U>(
      selector: (state: AppConfig) => U,
      listener: (selectedState: U, previousSelectedState: U) => void,
      options?: { equalityFn?: (a: U, b: U) => boolean; fireImmediately?: boolean }
    ): () => void
  }
}

export const CONFIG_FORMAT = 'openskyhawk-client-config'

export type AppSettings = Omit<AppConfig, 'psu'>

export interface ConfigSnapshot {
  app: AppSettings
  nodeMapping: NodeMappingFile
  powerSupply: PsuSetting
  calibration: CalCache
}

export type SectionId = keyof ConfigSnapshot

export interface ConfigFile {
  format: typeof CONFIG_FORMAT
  version: number
  exportedAt: string
  /** Client version that wrote it. */
  client: string
  sections: Partial<ConfigSnapshot>
  /**
   * Set on an automatic backup only: what it was saved before, kept in the file itself so it still
   * says so if the file is moved. Optional and additive — a reader that does not know it ignores
   * it, so the format version stays the same. The sections it holds are its `sections`.
   */
  backup?: { before: BackupBefore }
}

/**
 * What an automatic backup was saved before: the import of a file (its name), or the restore of
 * another backup (when that one was saved, as an ISO time).
 */
export type BackupBefore =
  | { kind: 'import'; fileName: string }
  | { kind: 'restore'; savedAt: string }

/** One automatic backup in `<userData>/backups`, as Settings › Configuration lists it. */
export interface BackupEntry {
  /** Its name in the backups folder: what `config:backup-restore` opens. */
  file: string
  /** When it was saved, as an ISO time. */
  savedAt: string
  /** What it was saved before; absent for a backup written before backups said so (an import). */
  before?: BackupBefore
  /** The titles of the sections it holds, in section order ("App settings", …). */
  sections: string[]
}

/**
 * `config:backups` (and `config:backups-get`'s answer): the automatic backups, newest first, at
 * most `keep` of them — main deletes older ones after each new backup.
 */
export interface BackupList {
  backups: BackupEntry[]
  /** How many main keeps. */
  keep: number
  /** The file manager Show in … opens the folder in, by platform. */
  fileManager: 'finder' | 'explorer' | 'folder'
}

/** Before main has said anything: no backups. */
export const BACKUP_LIST_DEFAULT: BackupList = { backups: [], keep: 5, fileManager: 'folder' }

/** One `key  from → to` line. `axis` set: the renderer names the axis (it owns the labels). */
export interface DiffRow {
  k: string
  from: string
  to: string
  axis?: number
  board?: string
}

export interface SectionDiff {
  id: SectionId
  title: string
  /** Short count for the heading: "2 changes", "3 nodes", "4 axes · board 4134-A7". */
  summary: string
  rows: DiffRow[]
  /** What applying the section does, when the review should say so (R3.3: ConfigTransfer's). */
  note?: string
}

/**
 * What came of an export (R3.4a: ConfigTransfer says so; the renderer read it from which field was
 * set before): written to `path`, the save dialog cancelled, or the write failed.
 */
export type ConfigExportResult =
  | { outcome: 'saved'; path: string }
  | { outcome: 'canceled' }
  | { outcome: 'failed'; error: string }

export interface ImportPreview {
  /** Names the file held in main for `applyConfigImport`. */
  token: string
  fileName: string
  exportedAt?: string
  client?: string
  /** One per section the file has and this client knows; `rows` empty = no change. */
  sections: SectionDiff[]
  /** Sections from a newer client, left out. */
  skipped: string[]
  /**
   * Sections this client knows that are malformed or incomplete (C1), left out: never read as an
   * empty or default setting. The review lists each as skipped, with main's reason.
   */
  rejected: RejectedSection[]
  /** Every section matches the current setup: nothing to apply. */
  identical: boolean
  /**
   * Set when the file is one of the automatic backups (`config:backup-restore`): the review is a
   * restore, of the backup saved then, before what it names.
   */
  backup?: { savedAt: string; before?: BackupBefore }
}

/** A known section an import left out (C1): the review says "Skipped — {title}: {reason}." */
export interface RejectedSection {
  id: SectionId
  title: string
  /** Why, completing "{title}: …", e.g. "it has no list of boards". */
  reason: string
}

export type ConfigImportOpen =
  | { status: 'canceled' }
  | { status: 'error'; error: string }
  | { status: 'ready'; preview: ImportPreview }

export type ConfigImportApplyResult =
  | { ok: true; applied: SectionId[]; backupPath?: string; config: AppConfig }
  | { ok: false; error: string }

/** This topic's main -> renderer pushes; shared/app assembles them into `PushChannels`. */
export interface ConfigPushChannels {
  'config:changed': ConfigChanged
  'config:backups': BackupList
}

/** Push channel names (main -> renderer). */
export const CONFIG_PUSH = {
  configChanged: 'config:changed',
  configBackups: 'config:backups'
} as const

/** Intent channel names (renderer -> main, invoke/response). */
export const CONFIG_CTRL = {
  configGet: 'config:get',
  configSet: 'config:set',
  configExport: 'config:export',
  configImportOpen: 'config:import-open',
  configImportApply: 'config:import-apply',
  configEdit: 'config:edit',
  configBackupsGet: 'config:backups-get',
  configBackupRestore: 'config:backup-restore',
  configBackupsReveal: 'config:backups-reveal'
} as const
