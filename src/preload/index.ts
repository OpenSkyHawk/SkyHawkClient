import { contextBridge, ipcRenderer } from 'electron'
import type { PushChannel, PushChannels } from '@shared/ipc'

// Minimal, typed bridge: the renderer subscribes to main-process push channels.
// Control actions (set port, pause log, …) are added alongside as the app grows.
const api = {
  on<C extends PushChannel>(channel: C, cb: (data: PushChannels[C]) => void): () => void {
    const listener = (_e: unknown, data: PushChannels[C]): void => cb(data)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
}

contextBridge.exposeInMainWorld('skyhawk', api)

export type SkyhawkApi = typeof api
