// Config topic contract (arch-phase0-v2 §2.3): the app settings, their defaults, and configuration
// export / import (#67). Imported by main, preload and the renderer.
import { COMMAND_PORT, EXPORT_PORT } from '../dcs/ipc'
import {
  DEFAULT_PSU,
  type NodeMappingFile,
  type PsuLimits,
  type PsuPreset,
  type PsuSetting
} from '../nodes/ipc'
import type { CalCache } from '../hid/calibration/ipc'

export type SourceMode = 'bridge' | 'monitor' | 'replay'
export type DcsTransport = 'loopback-multicast' | 'unicast-listen' | 'tcp-to-host'

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
}

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

export interface ConfigExportResult {
  /** Where it was written; absent when the dialog was cancelled or the write failed. */
  path?: string
  error?: string
}

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
  /** Every section matches the current setup: nothing to apply. */
  identical: boolean
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
}

/** Push channel names (main -> renderer). */
export const CONFIG_PUSH = {
  configChanged: 'config:changed'
} as const

/** Intent channel names (renderer -> main, invoke/response). */
export const CONFIG_CTRL = {
  configGet: 'config:get',
  configSet: 'config:set',
  configExport: 'config:export',
  configImportOpen: 'config:import-open',
  configImportApply: 'config:import-apply',
  configEdit: 'config:edit'
} as const
