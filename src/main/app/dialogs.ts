// The save and open dialogs the intents show, as one `Dialogs` port: each topic's ipc.ts declares
// the dialogs it needs, and this answers them with electron's. Each resolves to the picked path,
// or undefined when the dialog was canceled or came back without one. It also opens a folder in
// the file manager (config's Show in Finder), as debug:reveal does with electron's `shell`.
import { dialog, shell } from 'electron'
import type { ConfigDialogs } from '../config'
import type { DcsDialogs } from '../dcs'
import type { EventsDialogs } from '../events'

export type Dialogs = ConfigDialogs & DcsDialogs & EventsDialogs

const CONFIG_FILTER = [{ name: 'OpenSkyhawk configuration', extensions: ['json'] }]
/** Generous: a full export is a few KB. Anything bigger is not one. */
const CONFIG_MAX_BYTES = 5 * 1024 * 1024

const CAPTURE_FILTER = [{ name: 'DCS-BIOS capture', extensions: ['json'] }]

export const dialogs: Dialogs = {
  configMaxBytes: CONFIG_MAX_BYTES,

  async showFolder(path) {
    // openPath answers why it could not open the folder, or '' — there is nothing to show it on.
    await shell.openPath(path)
  },

  async saveConfig(defaultPath) {
    const res = await dialog.showSaveDialog({
      title: 'Export configuration',
      defaultPath,
      filters: CONFIG_FILTER
    })
    if (res.canceled || !res.filePath) return undefined
    return res.filePath
  },

  async openConfig() {
    const res = await dialog.showOpenDialog({
      title: 'Import configuration',
      properties: ['openFile'],
      filters: CONFIG_FILTER
    })
    const path = res.filePaths[0]
    if (res.canceled || !path) return undefined
    return path
  },

  async saveLog() {
    const res = await dialog.showSaveDialog({
      title: 'Export log',
      defaultPath: `skyhawk-log-${Date.now()}.tsv`,
      filters: [{ name: 'Log', extensions: ['tsv', 'txt'] }]
    })
    if (res.canceled || !res.filePath) return undefined
    return res.filePath
  },

  async saveEvents() {
    const res = await dialog.showSaveDialog({
      title: 'Export events',
      defaultPath: `skyhawk-events-${Date.now()}.tsv`,
      filters: [{ name: 'Events', extensions: ['tsv', 'txt'] }]
    })
    if (res.canceled || !res.filePath) return undefined
    return res.filePath
  },

  async saveCapture() {
    const res = await dialog.showSaveDialog({
      title: 'Record DCS-BIOS capture',
      defaultPath: `skyhawk-capture-${Date.now()}.json`,
      filters: CAPTURE_FILTER
    })
    if (res.canceled || !res.filePath) return undefined
    return res.filePath
  },

  async openCapture() {
    const res = await dialog.showOpenDialog({
      title: 'Open DCS-BIOS capture',
      properties: ['openFile'],
      filters: CAPTURE_FILTER
    })
    const path = res.filePaths[0]
    if (res.canceled || !path) return undefined
    return path
  }
}
