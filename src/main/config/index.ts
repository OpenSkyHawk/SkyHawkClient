// config: settings and the configuration file transfer. Exports only what other topics use
// (arch-phase0-v2 §2.1).
export { SettingsService } from './settings-service'
export { ConfigTransfer } from './config-transfer'
export { BackupFolder } from './backup-folder'
export { jsonFile, type JsonFile, type JsonRead } from './json-store'
export { registerConfigIpc, type ConfigDialogs } from './ipc'
