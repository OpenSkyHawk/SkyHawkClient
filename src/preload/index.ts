import { contextBridge, ipcRenderer } from 'electron'
import type { LogEvent } from '@shared/events'
import {
  CTRL,
  type DebugDumpResult,
  type PushChannel,
  type PushChannels,
  type RelayStatus,
  type SkyhawkApi
} from '@shared/app'
import type {
  AppConfig,
  ConfigExportResult,
  ConfigImportApplyResult,
  ConfigImportOpen,
  ConfigView
} from '@shared/config'
import type { CaptureState, ExportResult, RelayResult, ReplayLoad } from '@shared/dcs'
import type { HidAvailability } from '@shared/hid'
import type {
  NodeBatchResult,
  NodeMappingResult,
  NodeRegistryInfo,
  NodeSnapshot,
  ResetPreview
} from '@shared/nodes'

// Typed bridge: main -> renderer push subscriptions + renderer -> main control.
const api: SkyhawkApi = {
  on<C extends PushChannel>(channel: C, cb: (data: PushChannels[C]) => void): () => void {
    const listener = (_e: unknown, data: PushChannels[C]): void => cb(data)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },
  getConfig: () => ipcRenderer.invoke(CTRL.configGet) as Promise<ConfigView>,
  setConfig: (patch) => ipcRenderer.invoke(CTRL.configSet, patch) as Promise<AppConfig>,
  editConfig: (edit) => ipcRenderer.invoke(CTRL.configEdit, edit) as Promise<AppConfig>,
  exportConfig: () => ipcRenderer.invoke(CTRL.configExport) as Promise<ConfigExportResult>,
  openConfigImport: () => ipcRenderer.invoke(CTRL.configImportOpen) as Promise<ConfigImportOpen>,
  applyConfigImport: (token, sections, backup) =>
    ipcRenderer.invoke(
      CTRL.configImportApply,
      token,
      sections,
      backup
    ) as Promise<ConfigImportApplyResult>,
  startRelay: () => ipcRenderer.invoke(CTRL.relayStart) as Promise<RelayResult>,
  stopRelay: () => ipcRenderer.invoke(CTRL.relayStop) as Promise<RelayResult>,
  toggleRelay: (relaying: boolean) =>
    ipcRenderer.invoke(CTRL.relayToggle, relaying) as Promise<RelayResult>,
  getStatus: () => ipcRenderer.invoke(CTRL.relayStatus) as Promise<RelayStatus>,
  connectDevice: () => ipcRenderer.invoke(CTRL.deviceConnect) as Promise<void>,
  disconnectDevice: () => ipcRenderer.invoke(CTRL.deviceDisconnect) as Promise<void>,
  exportLog: (text: string) => ipcRenderer.invoke(CTRL.logExport, text) as Promise<ExportResult>,
  getEvents: () => ipcRenderer.invoke(CTRL.eventsGet) as Promise<LogEvent[]>,
  clearEvents: () => ipcRenderer.invoke(CTRL.eventsClear) as Promise<void>,
  exportEvents: () => ipcRenderer.invoke(CTRL.eventsExport) as Promise<ExportResult>,
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
  resetNode: (nodeId) =>
    ipcRenderer.invoke(CTRL.nodeMappingResetNode, nodeId) as Promise<NodeMappingResult>,
  resetNodeMapping: (opts) =>
    ipcRenderer.invoke(CTRL.nodeMappingReset, opts) as Promise<NodeMappingResult>,
  previewNodeReset: () => ipcRenderer.invoke(CTRL.nodeMappingResetPreview) as Promise<ResetPreview>,
  getNodeRegistry: () => ipcRenderer.invoke(CTRL.nodeRegistry) as Promise<NodeRegistryInfo>,
  hideNode: (nodeId, on) =>
    ipcRenderer.invoke(CTRL.nodeMappingHide, nodeId, on) as Promise<NodeMappingResult>,
  addAllNodes: (bulk) =>
    ipcRenderer.invoke(CTRL.nodeMappingAddAll, bulk) as Promise<NodeBatchResult>,
  unhideNodes: (nodeIds) =>
    ipcRenderer.invoke(CTRL.nodeMappingUnhide, nodeIds) as Promise<NodeBatchResult>,
  setSerialMonitor: (on: boolean) => ipcRenderer.invoke(CTRL.serialMonitor, on) as Promise<void>,
  dumpSerialPorts: () => ipcRenderer.invoke(CTRL.debugDumpPorts) as Promise<DebugDumpResult>,
  revealDebugLog: () => ipcRenderer.invoke(CTRL.debugReveal) as Promise<void>,
  calOpen: (axis: number, review?: boolean) =>
    ipcRenderer.invoke(CTRL.calOpen, axis, review) as Promise<void>,
  calClose: () => ipcRenderer.invoke(CTRL.calClose) as Promise<void>,
  calSelectAxis: (axis: number) => ipcRenderer.invoke(CTRL.calSelectAxis, axis) as Promise<void>,
  calStartCapture: () => ipcRenderer.invoke(CTRL.calStartCapture) as Promise<void>,
  calRetry: () => ipcRenderer.invoke(CTRL.calRetry) as Promise<void>,
  calSetSelfCentring: (selfCentring: boolean) =>
    ipcRenderer.invoke(CTRL.calSetSelfCentring, selfCentring) as Promise<void>,
  calSave: () => ipcRenderer.invoke(CTRL.calSave) as Promise<void>,
  calRestore: () => ipcRenderer.invoke(CTRL.calRestore) as Promise<void>,
  calDeleteAxis: (idx: number) => ipcRenderer.invoke(CTRL.calDeleteAxis, idx) as Promise<void>,
  calSetRestoreOpen: (open: boolean) =>
    ipcRenderer.invoke(CTRL.calSetRestoreOpen, open) as Promise<void>,
  calAttach: (on: boolean) => ipcRenderer.invoke(CTRL.calAttach, on) as Promise<void>
}

contextBridge.exposeInMainWorld('skyhawk', api)

export type { SkyhawkApi }
