import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { CTRL, type AppConfig, type PushChannel, type PushChannels } from '@shared/ipc'
import { Session } from './session'

let mainWindow: BrowserWindow | null = null

function emit<C extends PushChannel>(channel: C, payload: PushChannels[C]): void {
  mainWindow?.webContents.send(channel, payload)
}

const session = new Session(emit)

function registerIpc(): void {
  ipcMain.handle(CTRL.configGet, () => session.getConfig())
  ipcMain.handle(CTRL.configSet, (_e, patch: Partial<AppConfig>) => session.setConfig(patch))
  ipcMain.handle(CTRL.relayStart, () => session.start())
  ipcMain.handle(CTRL.relayStop, () => session.stop())
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#0a0e1a',
    title: 'OpenSkyhawk Client',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  mainWindow = win

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // electron-vite sets ELECTRON_RENDERER_URL in dev; load the built file otherwise.
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  session.stop()
  if (process.platform !== 'darwin') app.quit()
})
