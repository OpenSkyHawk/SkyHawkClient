// App launch and quit: the userData override, the services, the window and the IPC, in the order
// electron needs them.
import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigTransfer } from '../config'
import { loadCalCache, saveCalCache } from '../hid/calibration'
import { AppServices } from './app-services'
import { dialogs } from './dialogs'
import { registerIpc } from './ipc'
import { claimSingleInstance } from './single-instance'
import { storeFiles, storePaths, userDataOverride } from './user-data'
import { createWindow, currentWindow, emit } from './window'

export function start(): void {
  // Before anything touches userData: dev worktrees get their own folder (#81).
  const userDataDir = userDataOverride({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    env: process.env,
    cwd: process.cwd()
  })
  if (userDataDir) {
    mkdirSync(userDataDir, { recursive: true }) // setPath throws on a missing folder
    app.setPath('userData', userDataDir)
  }

  // After setPath: the lock is per <userData>, so dev worktrees still run side by side (D4/M5).
  // Without it, quit before any service, port or file is touched.
  if (!claimSingleInstance(app, currentWindow, createWindow)) return

  /** The <userData> files, handed to the topics that own them (P6: only app asks electron). */
  const paths = storePaths(() => app.getPath('userData'))
  /** The same files as ports, for ConfigTransfer's calibration section. */
  const { cacheFile } = storeFiles(paths)

  const services = new AppServices(emit, paths)

  const transfer = new ConfigTransfer({
    getConfig: () => services.settings.get(),
    setConfig: (config) => services.settings.apply(config, false),
    imported: () => services.settings.imported(),
    nodes: services.nodes,
    loadCalCache: () => loadCalCache(cacheFile, services.journal),
    saveCalCache: (cache) => saveCalCache(cache, cacheFile, services.journal),
    backupDir: () => join(app.getPath('userData'), 'backups'),
    clientVersion: () => app.getVersion()
  })

  app.whenReady().then(() => {
    services.settings.load() // seed from persisted settings
    registerIpc(ipcMain, { services, transfer, dialogs })
    createWindow()
    services.open() // the device link is up from launch, relaying or not (#69)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    services.relay.stop()
    if (process.platform !== 'darwin') app.quit()
  })

  // Releases the port: the link otherwise holds it for as long as the app runs.
  app.on('will-quit', () => services.shutdown())
}
