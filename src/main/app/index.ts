import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CTRL, type PushChannel, type PushChannels } from '@shared/app/ipc'
import type { AppConfig, ConfigExportResult, ConfigImportOpen } from '@shared/config/ipc'
import type { CalCacheEntry, CalCommitAxis } from '@shared/hid/calibration/ipc'
import type { CaptureState, ReplayLoad } from '@shared/dcs/ipc'
import type { HidAvailability } from '@shared/hid/ipc'
import type { AdoptSpec, MappingPatch, ResetOptions } from '@shared/nodes/ipc'
import { eventsToTsv } from '@shared/events'
import { HID_CONTROLS, HID_ID, HID_REPORT_LAYOUT } from '@shared/firmware'
import { Session } from './session'
import { loadConfig, saveConfig } from './settings'
import { loadCalCache, saveCalCache } from './cal-cache'
import { ConfigTransfer } from './config-transfer'
import { debugLog, debugLogPath, setDebugEnabled } from './debug'
import { listSerialPorts } from './serial'
import { userDataOverride } from './user-data'

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

/** Report indices the firmware catalogues, derived from HIDControls.h. */
function hidAvailability(): HidAvailability {
  const axes: number[] = []
  const hats: number[] = []
  const buttons: number[] = []
  for (const c of HID_CONTROLS) {
    if (
      c.id >= HID_ID.AXIS_MIN &&
      c.id <= HID_ID.AXIS_MAX &&
      c.id - HID_ID.AXIS_MIN < HID_REPORT_LAYOUT.axes.count
    ) {
      axes.push(c.id - HID_ID.AXIS_MIN)
    } else if (
      c.id >= HID_ID.HAT_MIN &&
      c.id <= HID_ID.HAT_MAX &&
      c.id - HID_ID.HAT_MIN < HID_REPORT_LAYOUT.hats.count
    ) {
      hats.push(c.id - HID_ID.HAT_MIN)
    } else if (
      c.id >= HID_ID.BUTTON_MIN &&
      c.id <= HID_ID.BUTTON_MAX &&
      c.id - HID_ID.BUTTON_MIN < HID_REPORT_LAYOUT.buttons.count
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

/** Apply and persist a settings change: the one path for config:set and a config import. */
function applyConfig(patch: Partial<AppConfig>): AppConfig {
  const config = session.setConfig(patch)
  setDebugEnabled(config.debugMode)
  saveConfig(config)
  return config
}

const transfer = new ConfigTransfer({
  getConfig: () => session.getConfig(),
  setConfig: (config) => applyConfig(config),
  nodes: session.link.nodes,
  loadCalCache,
  saveCalCache,
  backupDir: () => join(app.getPath('userData'), 'backups'),
  clientVersion: () => app.getVersion()
})

const CONFIG_FILTER = [{ name: 'OpenSkyhawk configuration', extensions: ['json'] }]
/** Generous: a full export is a few KB. Anything bigger is not one. */
const CONFIG_MAX_BYTES = 5 * 1024 * 1024

const CAPTURE_FILTER = [{ name: 'DCS-BIOS capture', extensions: ['json'] }]

function registerIpc(): void {
  ipcMain.handle(CTRL.configGet, () => session.getConfig())
  ipcMain.handle(CTRL.configSet, (_e, patch: Partial<AppConfig>) => applyConfig(patch))
  ipcMain.handle(CTRL.configExport, async (): Promise<ConfigExportResult> => {
    const res = await dialog.showSaveDialog({
      title: 'Export configuration',
      defaultPath: transfer.defaultFileName(),
      filters: CONFIG_FILTER
    })
    if (res.canceled || !res.filePath) return {}
    try {
      writeFileSync(res.filePath, transfer.exportText())
      return { path: res.filePath }
    } catch (err) {
      return { error: `Could not write the file: ${err instanceof Error ? err.message : err}` }
    }
  })
  ipcMain.handle(CTRL.configImportOpen, async (): Promise<ConfigImportOpen> => {
    const res = await dialog.showOpenDialog({
      title: 'Import configuration',
      properties: ['openFile'],
      filters: CONFIG_FILTER
    })
    const path = res.filePaths[0]
    if (res.canceled || !path) return { status: 'canceled' }
    try {
      if (statSync(path).size > CONFIG_MAX_BYTES) {
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
  ipcMain.handle(CTRL.configImportApply, (_e, token: string, sections: unknown, backup: unknown) =>
    transfer.apply(token, sections, backup)
  )
  ipcMain.handle(CTRL.relayStart, () => session.start())
  ipcMain.handle(CTRL.relayStop, () => session.stop())
  ipcMain.handle(CTRL.relayStatus, () => session.status())
  ipcMain.handle(CTRL.deviceConnect, () => session.link.connect())
  ipcMain.handle(CTRL.deviceDisconnect, () => session.link.disconnect())
  ipcMain.handle(CTRL.hidAvailability, () => hidAvailability())
  ipcMain.handle(CTRL.nodesRefresh, () => session.link.requestNodes())
  ipcMain.handle(CTRL.nodesGet, () => session.link.nodes.snapshot())
  ipcMain.handle(CTRL.nodeMappingSet, (_e, id: number, patch: MappingPatch) =>
    session.link.nodes.setMapping(id, patch)
  )
  ipcMain.handle(CTRL.nodeMappingAdopt, (_e, id: number, spec: AdoptSpec) =>
    session.link.nodes.adopt(id, spec)
  )
  ipcMain.handle(CTRL.nodeMappingForget, (_e, id: number) => session.link.nodes.forget(id))
  ipcMain.handle(CTRL.nodeMappingResetNode, (_e, id: number) => session.link.nodes.resetBoard(id))
  ipcMain.handle(CTRL.nodeMappingReset, (_e, opts?: ResetOptions) =>
    session.link.nodes.resetAll(opts)
  )
  ipcMain.handle(CTRL.nodeMappingResetPreview, () => session.link.nodes.previewReset())
  ipcMain.handle(CTRL.nodeRegistry, () => session.link.nodes.registry())
  ipcMain.handle(CTRL.nodeMappingHide, (_e, id: number, on: boolean) =>
    session.link.nodes.hide(id, on)
  )
  ipcMain.handle(CTRL.serialMonitor, (_e, on: boolean) => session.link.setSerialMonitor(on))

  // Axis calibration (#46). Every one returns a discriminated CalResult rather than throwing:
  // an ipcRenderer.invoke rejection flattens to a plain Error, which would lose the
  // timeout-vs-nack distinction the UI's failure messaging depends on.
  ipcMain.handle(CTRL.calHello, () => session.link.calHello())
  ipcMain.handle(CTRL.calRead, () => session.link.calRead())
  ipcMain.handle(CTRL.calSessionOpen, (_e, axisIdx: number) => session.link.calSessionOpen(axisIdx))
  ipcMain.handle(CTRL.calStreamSelect, (_e, axisIdx: number) =>
    session.link.calStreamSelect(axisIdx)
  )
  ipcMain.handle(CTRL.calCommit, (_e, axis: CalCommitAxis) => session.link.calCommit(axis))
  ipcMain.handle(CTRL.calReset, (_e, idx: number) => session.link.calReset(idx))
  ipcMain.handle(CTRL.calCacheRead, () => session.link.calCacheRead())
  ipcMain.handle(CTRL.calCacheStore, (_e, axes: CalCacheEntry[]) =>
    session.link.calCacheStore(axes)
  )
  ipcMain.handle(CTRL.calCacheDrop, (_e, idx: number) => session.link.calCacheDrop(idx))
  ipcMain.handle(CTRL.calSessionClose, () => session.link.calSessionClose())

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

  ipcMain.handle(CTRL.eventsGet, () => session.events.snapshot())
  ipcMain.handle(CTRL.eventsClear, () => session.events.clear())
  ipcMain.handle(CTRL.eventsExport, async () => {
    const rows = session.events.snapshot()
    const res = await dialog.showSaveDialog({
      title: 'Export events',
      defaultPath: `skyhawk-events-${Date.now()}.tsv`,
      filters: [{ name: 'Events', extensions: ['tsv', 'txt'] }]
    })
    if (res.canceled || !res.filePath) return {}
    writeFileSync(res.filePath, eventsToTsv(rows))
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
  session.open() // the device link is up from launch, relaying or not (#69)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  session.stop()
  if (process.platform !== 'darwin') app.quit()
})

// Releases the port: the link otherwise holds it for as long as the app runs.
app.on('will-quit', () => session.shutdown())
