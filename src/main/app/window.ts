// The app's one window, and `emit`: every main → renderer push goes through it.
import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import type { PushChannel, PushChannels } from '@shared/app'

let mainWindow: BrowserWindow | null = null

export function emit<C extends PushChannel>(channel: C, payload: PushChannels[C]): void {
  mainWindow?.webContents.send(channel, payload)
}

export function createWindow(): void {
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
