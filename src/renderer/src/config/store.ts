// The settings as the forms hold them, and the settings intents (R3.4b: the config slice of the
// old single store, cut verbatim, plus the export / import calls Settings › Configuration made
// straight to `window.skyhawk`, and the Diagnostics actions). The IPC adapter binds the intents and
// delivers the pushes.
import { create } from 'zustand'
import type { SkyhawkApi } from '@shared/app'
import {
  BACKUP_LIST_DEFAULT,
  DEFAULT_CONFIG,
  PSU_VIEW_DEFAULT,
  type AppConfig,
  type BackupList,
  type ConfigChanged,
  type ConfigEdit,
  type ConfigView,
  type DcsTransport,
  type PsuView
} from '@shared/config'
import type { PsuLimits, PsuSetting } from '@shared/nodes'

export type SourceMode = 'bridge' | 'monitor' | 'replay'
export type TransportId = 'tcp' | 'loop' | 'uni'

/** A call to main as the view made it: undefined outside Electron (no `window.skyhawk`). */
type Ask<K extends keyof Omit<SkyhawkApi, 'on'>> = (
  ...args: Parameters<SkyhawkApi[K]>
) => ReturnType<SkyhawkApi[K]> | undefined

export interface ConfigState {
  sourceMode: SourceMode
  transport: TransportId
  host: string
  port: string
  autoConnect: boolean

  // replay
  replayDriveSerial: boolean

  // Cockpit options (#67)
  attentionBanner: boolean
  psu: PsuSetting
  /** What the PSU setting comes to — preset, limits, name — as main resolves it (R3.3). */
  psuView: PsuView

  // developer / debug
  debugMode: boolean
  debugDump?: { path: string; count: number }

  setConfigField: (patch: Partial<ConfigFields>) => void
  /** Settings › Cockpit's PSU switch: main switches the mode over the setting it holds (R3.4a). */
  setPsuMode: (mode: PsuSetting['mode']) => void
  /** Settings › Cockpit's PSU limit, as typed: main refuses, deletes or sets it (R3.4a). */
  setPsuLimit: (key: keyof PsuLimits, text: string) => void
  dumpSerialPorts: () => void
  revealDebugLog: () => void
  exportConfig: Ask<'exportConfig'>
  openConfigImport: Ask<'openConfigImport'>
  applyConfigImport: Ask<'applyConfigImport'>

  /** The automatic backups, as main pushes them (`config:backups`, #136). */
  backups: BackupList
  /** Ask main for the list as it is on disk now (Settings › Configuration opening). */
  loadConfigBackups: () => void
  /** Read a backup into the import review, as a restore. */
  openConfigBackup: Ask<'openConfigBackup'>
  /** Open the backups folder in the file manager. */
  revealConfigBackups: () => void
}

/** Main, as the IPC adapter hands it over; nothing until it binds. */
let api: () => SkyhawkApi | undefined = () => undefined

/** The IPC adapter's binding: every intent reads `window.skyhawk` through it, at call time. */
export function bindConfig(skyhawk: () => SkyhawkApi | undefined): void {
  api = skyhawk
}

// ── renderer <-> main transport mapping ──────────────────────────────────────
const TRANSPORT_TO_IPC: Record<TransportId, DcsTransport> = {
  tcp: 'tcp-to-host',
  loop: 'loopback-multicast',
  uni: 'unicast-listen'
}

/** The contract's transport as the forms name it. */
export function viewTransport(transport: DcsTransport): TransportId {
  const t = (Object.keys(TRANSPORT_TO_IPC) as TransportId[]).find(
    (k) => TRANSPORT_TO_IPC[k] === transport
  )
  return t ?? 'tcp'
}

/** The store fields an AppConfig sets — on load, and after a config import replaces it. */
function configState(cfg: AppConfig): ConfigFields {
  return {
    sourceMode: cfg.sourceMode,
    transport: viewTransport(cfg.transport),
    host: cfg.host,
    port: String(cfg.commandPort),
    autoConnect: cfg.autoConnect,
    replayDriveSerial: cfg.replayDriveSerial,
    debugMode: cfg.debugMode,
    attentionBanner: cfg.attentionBanner,
    psu: cfg.psu
  }
}

/** The settings fields the forms edit, as the store holds them. */
type ConfigFields = Pick<
  ConfigState,
  | 'sourceMode'
  | 'transport'
  | 'host'
  | 'port'
  | 'autoConnect'
  | 'replayDriveSerial'
  | 'debugMode'
  | 'attentionBanner'
  | 'psu'
>

/** A form's change as main takes it (`config:edit`): the contract's transport, the port as typed. */
function configEdit(patch: Partial<ConfigFields>): ConfigEdit {
  const { transport, ...rest } = patch
  return { ...rest, ...(transport !== undefined && { transport: TRANSPORT_TO_IPC[transport] }) }
}

/** A form's change, to main (`config:edit`): main builds the settings and saves them (R3.3). */
const editConfig = (edit: ConfigEdit): void => void api()?.editConfig(edit)

export const useConfigStore = create<ConfigState>((set) => ({
  ...configState(DEFAULT_CONFIG),
  psuView: PSU_VIEW_DEFAULT,

  // What is typed stays as typed; main builds and saves the settings (`config:edit`, R3.3).
  setConfigField: (patch) => {
    set(patch as Partial<ConfigState>)
    editConfig(configEdit(patch))
  },

  // The switched setting comes back on `config:changed` (R3.4a).
  setPsuMode: (mode) => {
    editConfig({ psuMode: mode })
  },

  // The setting comes back on `config:changed` (R3.4a); the field keeps its own text.
  setPsuLimit: (key, text) => {
    editConfig({ psuLimit: { key, text } })
  },

  dumpSerialPorts: () => {
    void api()
      ?.dumpSerialPorts()
      .then((r) => set({ debugDump: r }))
  },

  revealDebugLog: () => {
    void api()?.revealDebugLog()
  },

  exportConfig: () => api()?.exportConfig(),
  openConfigImport: () => api()?.openConfigImport(),
  applyConfigImport: (token, sections, backup) => api()?.applyConfigImport(token, sections, backup),

  backups: BACKUP_LIST_DEFAULT,
  loadConfigBackups: () => {
    void api()
      ?.getConfigBackups()
      .then((list) => configFromMain.backups(list))
  },
  openConfigBackup: (file) => api()?.openConfigBackup(file),
  revealConfigBackups: () => {
    void api()?.revealConfigBackups()
  }
}))

/** What main sends this slice; the IPC adapter calls each as its push or pull lands. */
export const configFromMain = {
  /** `config:get`. */
  config: (v: ConfigView): void =>
    useConfigStore.setState({ ...configState(v.config), psuView: v.psu }),

  /**
   * `config:changed`. An import replaced the settings: the forms start over from them. A form's own
   * change leaves what is typed alone (the port as typed, N5); the PSU setting is main's either way,
   * since main switches its mode (R3.4a).
   */
  changed: (c: ConfigChanged): void =>
    useConfigStore.setState({
      psuView: c.psu,
      psu: c.config.psu,
      ...(c.source === 'import' ? configState(c.config) : {})
    }),

  /** `config:backups`, and `config:backups-get`'s answer. */
  backups: (list: BackupList): void => useConfigStore.setState({ backups: list })
}
