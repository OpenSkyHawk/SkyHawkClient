// config's intents for the automatic backups (#136), as app/ipc.ts registers them: the list, a
// restore's review and Show in Finder — which opens the backups folder through the dialogs port
// (electron's shell, in main/app), creating it first.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_CTRL } from '@shared/config'
import type { CtrlChannel, IpcListener } from '@shared/app'
import { BackupFolder } from './backup-folder'
import type { ConfigTransfer } from './config-transfer'
import { registerConfigIpc, type ConfigDialogs } from './ipc'
import type { SettingsService } from './settings-service'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skyhawk-config-ipc-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** registerConfigIpc's handlers, by channel, over a ConfigTransfer stand-in. */
function register(transfer: Partial<ConfigTransfer>) {
  const handlers = new Map<CtrlChannel, IpcListener>()
  const dialogs = {
    configMaxBytes: 1024,
    saveConfig: vi.fn(),
    openConfig: vi.fn(),
    showFolder: vi.fn(() => Promise.resolve())
  } satisfies ConfigDialogs
  registerConfigIpc(
    { handle: (channel, listener) => void handlers.set(channel, listener) },
    { settings: {} as SettingsService, transfer: transfer as ConfigTransfer, dialogs }
  )
  const invoke = (channel: CtrlChannel, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
  return { invoke, dialogs, handlers }
}

describe('config’s backup intents (#136)', () => {
  it('Show in Finder opens the backups folder in the file manager, created if need be', async () => {
    const folder = new BackupFolder({ dir: () => join(dir, 'backups') })
    const { invoke, dialogs } = register({ backupFolder: () => folder.ensure() })
    await invoke(CONFIG_CTRL.configBackupsReveal)
    expect(dialogs.showFolder).toHaveBeenCalledExactlyOnceWith(join(dir, 'backups'))
    expect(existsSync(join(dir, 'backups'))).toBe(true)
  })

  it('the list and a restore’s review are ConfigTransfer’s answers', () => {
    const list = { backups: [], keep: 5, fileManager: 'finder' as const }
    const opened = { status: 'error' as const, error: 'Invalid backup request' }
    const previewBackup = vi.fn(() => opened)
    const { invoke, handlers } = register({ backupList: () => list, previewBackup })
    expect(invoke(CONFIG_CTRL.configBackupsGet)).toBe(list)
    expect(invoke(CONFIG_CTRL.configBackupRestore, 'skyhawk-config-x.json')).toBe(opened)
    expect(previewBackup).toHaveBeenCalledWith('skyhawk-config-x.json')
    expect([...handlers.keys()].sort()).toEqual(Object.values(CONFIG_CTRL).sort())
  })
})
