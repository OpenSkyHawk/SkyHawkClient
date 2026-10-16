import { contextBridge, ipcRenderer } from 'electron'
import {
  CTRL,
  type AppConfig,
  type CalCacheEntry,
  type CalCommitAxis,
  type CalHello,
  type CalResult,
  type CalSnapshot,
  type CaptureState,
  type DebugDumpResult,
  type ExportResult,
  type HidAvailability,
  type NodeMappingResult,
  type NodeSnapshot,
  type PushChannel,
  type PushChannels,
  type RelayResult,
  type RelayStatus,
  type ReplayLoad,
  type SkyhawkApi
} from '@shared/ipc'
import type { CachedBoard } from '@shared/cal-cache'

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
  connectDevice: () => ipcRenderer.invoke(CTRL.deviceConnect) as Promise<void>,
  disconnectDevice: () => ipcRenderer.invoke(CTRL.deviceDisconnect) as Promise<void>,
  exportLog: (text: string) => ipcRenderer.invoke(CTRL.logExport, text) as Promise<ExportResult>,
  toggleCapture: () => ipcRenderer.invoke(CTRL.captureToggle) as Promise<CaptureState>,
  openReplay: () => ipcRenderer.invoke(CTRL.replayOpen) as Promise<ReplayLoad>,
  getHidAvailability: () => ipcRenderer.invoke(CTRL.hidAvailability) as Promise<HidAvailability>,
  refreshNodes: () => ipcRenderer.invoke(CTRL.nodesRefresh) as Promise<void>,
  getNodes: () => ipcRenderer.invoke(CTRL.nodesGet) as Promise<NodeSnapshot>,
  setNodeMapping: (nodeId, patch) =>
    ipcRenderer.invoke(CTRL.nodeMappingSet, nodeId, patch) as Promise<NodeMappingResult>,
  adoptNode: (nodeId, spec) =>
    ipcRenderer.invoke(CTRL.nodeMappingAdopt, nodeId, spec) as Promise<NodeMappingResult>,
  forgetNode: (nodeId) =>
    ipcRenderer.invoke(CTRL.nodeMappingForget, nodeId) as Promise<NodeMappingResult>,
  resetNodeMapping: () => ipcRenderer.invoke(CTRL.nodeMappingReset) as Promise<NodeMappingResult>,
  ignoreNode: (nodeId, on) =>
    ipcRenderer.invoke(CTRL.nodeMappingIgnore, nodeId, on) as Promise<NodeMappingResult>,
  hideNode: (nodeId, on) =>
    ipcRenderer.invoke(CTRL.nodeMappingHide, nodeId, on) as Promise<NodeMappingResult>,
  setSerialMonitor: (on: boolean) => ipcRenderer.invoke(CTRL.serialMonitor, on) as Promise<void>,
  dumpSerialPorts: () => ipcRenderer.invoke(CTRL.debugDumpPorts) as Promise<DebugDumpResult>,
  revealDebugLog: () => ipcRenderer.invoke(CTRL.debugReveal) as Promise<void>,
  calHello: () => ipcRenderer.invoke(CTRL.calHello) as Promise<CalResult<CalHello>>,
  calRead: () => ipcRenderer.invoke(CTRL.calRead) as Promise<CalResult<CalSnapshot>>,
  calSessionOpen: (axisIdx: number) =>
    ipcRenderer.invoke(CTRL.calSessionOpen, axisIdx) as Promise<
      CalResult<{ timeoutMs: number; axisIdx: number }>
    >,
  calStreamSelect: (axisIdx: number) =>
    ipcRenderer.invoke(CTRL.calStreamSelect, axisIdx) as Promise<CalResult<null>>,
  calCommit: (axis: CalCommitAxis) =>
    ipcRenderer.invoke(CTRL.calCommit, axis) as Promise<CalResult<null>>,
  calReset: (idx: number) => ipcRenderer.invoke(CTRL.calReset, idx) as Promise<CalResult<null>>,
  calCacheRead: () =>
    ipcRenderer.invoke(CTRL.calCacheRead) as Promise<
      CalResult<{ board?: CachedBoard; regressed: number[] }>
    >,
  calCacheStore: (axes: CalCacheEntry[]) =>
    ipcRenderer.invoke(CTRL.calCacheStore, axes) as Promise<CalResult<null>>,
  calCacheDrop: (idx: number) =>
    ipcRenderer.invoke(CTRL.calCacheDrop, idx) as Promise<CalResult<null>>,
  calSessionClose: () => ipcRenderer.invoke(CTRL.calSessionClose) as Promise<CalResult<null>>
}

contextBridge.exposeInMainWorld('skyhawk', api)

export type { SkyhawkApi }
