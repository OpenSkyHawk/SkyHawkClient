import { contextBridge, ipcRenderer } from 'electron'
import {
  CTRL,
  type AppConfig,
  type CaptureState,
  type PushChannel,
  type PushChannels,
  type RelayResult,
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
  toggleCapture: () => ipcRenderer.invoke(CTRL.captureToggle) as Promise<CaptureState>,
  openReplay: () => ipcRenderer.invoke(CTRL.replayOpen) as Promise<ReplayLoad>
}

contextBridge.exposeInMainWorld('skyhawk', api)

export type { SkyhawkApi }
