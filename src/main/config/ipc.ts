// config's intents: the settings (config:get / config:set) and the configuration file's export and
// import. app/ipc.ts registers them, in its order.
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import type { IpcRegistrar } from '@shared/app'
import {
  CONFIG_CTRL,
  type AppConfig,
  type ConfigExportResult,
  type ConfigImportOpen
} from '@shared/config'
import type { ConfigTransfer } from './config-transfer'
import type { SettingsService } from './settings-service'

/** The dialogs config's intents open (app/dialogs.ts). Each resolves to the picked path, if any. */
export interface ConfigDialogs {
  saveConfig(defaultPath: string): Promise<string | undefined>
  openConfig(): Promise<string | undefined>
  /** The largest file an import reads. */
  readonly configMaxBytes: number
}

export interface ConfigIpcDeps {
  settings: SettingsService
  transfer: ConfigTransfer
  dialogs: ConfigDialogs
}

export function registerConfigIpc(ipc: IpcRegistrar, deps: ConfigIpcDeps): void {
  const { settings, transfer, dialogs } = deps
  ipc.handle(CONFIG_CTRL.configGet, () => settings.get())
  ipc.handle(CONFIG_CTRL.configSet, (_e, patch: Partial<AppConfig>) => settings.apply(patch))
  ipc.handle(CONFIG_CTRL.configExport, async (): Promise<ConfigExportResult> => {
    const filePath = await dialogs.saveConfig(transfer.defaultFileName())
    if (!filePath) return {}
    try {
      writeFileSync(filePath, transfer.exportText())
      return { path: filePath }
    } catch (err) {
      return { error: `Could not write the file: ${err instanceof Error ? err.message : err}` }
    }
  })
  ipc.handle(CONFIG_CTRL.configImportOpen, async (): Promise<ConfigImportOpen> => {
    const path = await dialogs.openConfig()
    if (!path) return { status: 'canceled' }
    try {
      if (statSync(path).size > dialogs.configMaxBytes) {
        return { status: 'error', error: 'This file is too large to be a configuration file.' }
      }
      return transfer.preview(readFileSync(path, 'utf8'), path)
    } catch (err) {
      return {
        status: 'error',
        error: `Could not read the file: ${err instanceof Error ? err.message : err}`
      }
    }
  })
  ipc.handle(
    CONFIG_CTRL.configImportApply,
    (_e, token: string, sections: unknown, backup: unknown) =>
      transfer.apply(token, sections, backup)
  )
}
