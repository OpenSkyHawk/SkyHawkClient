import { contextBridge, ipcRenderer } from 'electron'
import {
  CTRL,
  type AppConfig,
  type CaptureState,
  type DebugDumpResult,
  type ExportResult,
  type HidAvailability,
  type PushChannel,
  type PushChannels,
  type RelayResult,
  type RelayStatus,
  type ReplayLoad,
  type SkyhawkApi
} from '@shared/ipc'

// Typed bridge: main -> renderer push subscriptions + renderer -> main control.
const api: SkyhawkApi = {
  on<C extends PushChannel>(channel: C, cb: (data: PushChannels[C]) => void): () => void {
    const listener = (_e: unknown, data: PushChannels[C]): void => cb(data)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },
  getConfig: () => ipcRenderer.invoke(CTRL.configGet) as Promise<AppConfig>,
  setConfig: (patch) => ipcRenderer.invoke(CTRL.configSet, patch) as Promise<AppConfig>,
  startRelay: () => ipcRenderer.invoke(CTRL.relayStart) as Promise<RelayResult>,
  stopRelay: () => ipcRenderer.invoke(CTRL.relayStop) as Promise<RelayResult>,
  getStatus: () => ipcRenderer.invoke(CTRL.relayStatus) as Promise<RelayStatus>,
  exportLog: (text: string) => ipcRenderer.invoke(CTRL.logExport, text) as Promise<ExportResult>,
  toggleCapture: () => ipcRenderer.invoke(CTRL.captureToggle) as Promise<CaptureState>,
  openReplay: () => ipcRenderer.invoke(CTRL.replayOpen) as Promise<ReplayLoad>,
  getHidAvailability: () => ipcRenderer.invoke(CTRL.hidAvailability) as Promise<HidAvailability>,
  refreshNodes: () => ipcRenderer.invoke(CTRL.nodesRefresh) as Promise<void>,
  dumpSerialPorts: () => ipcRenderer.invoke(CTRL.debugDumpPorts) as Promise<DebugDumpResult>,
  revealDebugLog: () => ipcRenderer.invoke(CTRL.debugReveal) as Promise<void>
}

contextBridge.exposeInMainWorld('skyhawk', api)

export type { SkyhawkApi }
