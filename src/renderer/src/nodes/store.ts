// The node model and the Cockpit snapshot as main pushes them, and the node intents
// (R3.4b: the nodes slice of the old single store, cut verbatim, plus the calls the Cockpit's
// dialogs and Settings made straight to `window.skyhawk`). The IPC adapter binds the intents and
// delivers the pushes.
import { create } from 'zustand'
import type { SkyhawkApi } from '@shared/app'
import { COCKPIT_IDLE, type CockpitSnapshot, type NodeModel } from '@shared/nodes'

/** A call to main as the view made it: undefined outside Electron (no `window.skyhawk`). */
type Ask<K extends keyof Omit<SkyhawkApi, 'on'>> = (
  ...args: Parameters<SkyhawkApi[K]>
) => ReturnType<SkyhawkApi[K]> | undefined

export interface NodesState {
  /** Roster + telemetry + mapping, as main combines them (#61). Kept, dimmed, while the link is down. */
  nodeModel?: NodeModel
  /**
   * The Cockpit tab's picture as main pushes it (`cockpit:snapshot`, R3.2): views, plan zones, band
   * (peak W included), Attention, side panels and the Adopt queue. Kept, dimmed, while the link is down.
   */
  cockpit: CockpitSnapshot

  /** `nodes:get`: the Settings sections' pull when they mount. */
  pullNodes: Ask<'getNodes'>
  getNodeRegistry: Ask<'getNodeRegistry'>
  setNodeMapping: Ask<'setNodeMapping'>
  adoptNode: Ask<'adoptNode'>
  addAllNodes: Ask<'addAllNodes'>
  resetNode: Ask<'resetNode'>
  forgetNode: Ask<'forgetNode'>
  hideNode: Ask<'hideNode'>
  unhideNodes: Ask<'unhideNodes'>
  previewNodeReset: Ask<'previewNodeReset'>
  resetNodeMapping: Ask<'resetNodeMapping'>
}

/** Main, as the IPC adapter hands it over; nothing until it binds. */
let api: () => SkyhawkApi | undefined = () => undefined

/** The IPC adapter's binding: every intent reads `window.skyhawk` through it, at call time. */
export function bindNodes(skyhawk: () => SkyhawkApi | undefined): void {
  api = skyhawk
}

export const useNodesStore = create<NodesState>(() => ({
  cockpit: COCKPIT_IDLE,

  pullNodes: () => api()?.getNodes(),
  getNodeRegistry: () => api()?.getNodeRegistry(),
  setNodeMapping: (nodeId, patch) => api()?.setNodeMapping(nodeId, patch),
  adoptNode: (nodeId, spec) => api()?.adoptNode(nodeId, spec),
  addAllNodes: (bulk) => api()?.addAllNodes(bulk),
  resetNode: (nodeId) => api()?.resetNode(nodeId),
  forgetNode: (nodeId) => api()?.forgetNode(nodeId),
  hideNode: (nodeId, on) => api()?.hideNode(nodeId, on),
  unhideNodes: (nodeIds) => api()?.unhideNodes(nodeIds),
  previewNodeReset: () => api()?.previewNodeReset(),
  resetNodeMapping: (opts) => api()?.resetNodeMapping(opts)
}))

/** What main sends this slice; the IPC adapter calls each as its push or pull lands. */
export const nodesFromMain = {
  /** `nodes:get`: node pushes only fire on change, so a reloaded renderer asks for the current picture. */
  nodes: (model: NodeModel | undefined): void => useNodesStore.setState({ nodeModel: model }),

  /** `nodes:model`. */
  model: (m: NodeModel): void => useNodesStore.setState({ nodeModel: m }),

  /** `cockpit:snapshot`. */
  cockpit: (c: CockpitSnapshot): void => useNodesStore.setState({ cockpit: c })
}
