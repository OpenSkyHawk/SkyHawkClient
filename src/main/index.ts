import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CTRL,
  type AppConfig,
  type CaptureState,
  type HidAvailability,
  type PushChannel,
  type PushChannels,
  type ReplayLoad
} from '@shared/ipc'
import { HID_CONTROLS, HID_ID } from './reference/hid-controls.generated'
import { Session } from './session'
import { loadConfig, saveConfig } from './settings'
import { debugLog, debugLogPath, setDebugEnabled } from './debug'
import { listSerialPorts } from './serial'

/** Report indices the firmware catalogues, derived from HIDControls.h. */
function hidAvailability(): HidAvailability {
  const axes: number[] = []
  const hats: number[] = []
  const buttons: number[] = []
  for (const c of HID_CONTROLS) {
    if (c.id >= HID_ID.AXIS_MIN && c.id <= HID_ID.AXIS_MAX && c.id - HID_ID.AXIS_MIN < 8) {
      axes.push(c.id - HID_ID.AXIS_MIN)
    } else if (c.id >= HID_ID.HAT_MIN && c.id <= HID_ID.HAT_MAX && c.id - HID_ID.HAT_MIN < 4) {
      hats.push(c.id - HID_ID.HAT_MIN)
    } else if (
      c.id >= HID_ID.BUTTON_MIN &&
      c.id <= HID_ID.BUTTON_MAX &&
      c.id - HID_ID.BUTTON_MIN < 128
    ) {
      buttons.push(c.id - HID_ID.BUTTON_MIN)
    }
  }
  return { axes, hats, buttons }
}

let mainWindow: BrowserWindow | null = null

function emit<C extends PushChannel>(channel: C, payload: PushChannels[C]): void {
  mainWindow?.webContents.send(channel, payload)
}

const session = new Session(emit)

const CAPTURE_FILTER = [{ name: 'DCS-BIOS capture', extensions: ['json'] }]

function registerIpc(): void {
  ipcMain.handle(CTRL.configGet, () => session.getConfig())
  ipcMain.handle(CTRL.configSet, (_e, patch: Partial<AppConfig>) => {
    const config = session.setConfig(patch)
    setDebugEnabled(config.debugMode)
    saveConfig(config)
    return config
  })
  ipcMain.handle(CTRL.relayStart, () => session.start())
  ipcMain.handle(CTRL.relayStop, () => session.stop())
  ipcMain.handle(CTRL.relayStatus, () => session.status())
  ipcMain.handle(CTRL.hidAvailability, () => hidAvailability())
  ipcMain.handle(CTRL.nodesRefresh, () => session.requestNodes())
  ipcMain.handle(CTRL.serialMonitor, (_e, on: boolean) => session.setSerialMonitor(on))

  ipcMain.handle(CTRL.logExport, async (_e, text: string) => {
    const res = await dialog.showSaveDialog({
      title: 'Export log',
      defaultPath: `skyhawk-log-${Date.now()}.tsv`,
      filters: [{ name: 'Log', extensions: ['tsv', 'txt'] }]
    })
    if (res.canceled || !res.filePath) return {}
    writeFileSync(res.filePath, text)
    return { path: res.filePath }
  })

  ipcMain.handle(CTRL.debugDumpPorts, async () => {
    const ports = await listSerialPorts()
    debugLog('serial.list', ports, true) // force-write regardless of the toggle
    return { path: debugLogPath(), count: ports.length }
  })
  ipcMain.handle(CTRL.debugReveal, () => {
    shell.showItemInFolder(debugLogPath())
  })

  ipcMain.handle(CTRL.captureToggle, async (): Promise<CaptureState> => {
    if (session.isRecording()) {
      const { path, events } = session.stopRecording()
      return { recording: false, path, events }
    }
    const res = await dialog.showSaveDialog({
      title: 'Record DCS-BIOS capture',
      defaultPath: `skyhawk-capture-${Date.now()}.json`,
      filters: CAPTURE_FILTER
    })
    if (res.canceled || !res.filePath) return { recording: false }
    session.startRecording(res.filePath)
    return { recording: true, path: res.filePath }
  })

  ipcMain.handle(CTRL.replayOpen, async (): Promise<ReplayLoad> => {
    const res = await dialog.showOpenDialog({
      title: 'Open DCS-BIOS capture',
      properties: ['openFile'],
      filters: CAPTURE_FILTER
    })
    const path = res.filePaths[0]
    if (res.canceled || !path) return { loaded: false }
    try {
      const info = session.loadReplay(path)
      return { loaded: true, path, events: info.events, durationMs: info.durationMs }
    } catch {
      return { loaded: false }
    }
  })
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
  const cfg = session.setConfig(loadConfig()) // seed from persisted settings
  setDebugEnabled(cfg.debugMode)
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
