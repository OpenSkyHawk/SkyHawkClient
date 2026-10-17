// nodes' intents: the roster, the node data and the node mapping. app/ipc.ts registers them.
import type { IpcRegistrar } from '@shared/app'
import {
  NODES_CTRL,
  type AdoptRequest,
  type AdoptSpec,
  type MappingPatch,
  type ResetOptions
} from '@shared/nodes'
import type { NodeHub } from './node-hub'

export interface NodesIpcDeps {
  nodes: NodeHub
}

export function registerNodesIpc(ipc: IpcRegistrar, deps: NodesIpcDeps): void {
  const { nodes } = deps
  ipc.handle(NODES_CTRL.nodesRefresh, () => nodes.requestNodes())
  ipc.handle(NODES_CTRL.nodesGet, () => nodes.snapshot())
  ipc.handle(NODES_CTRL.nodeMappingSet, (_e, id: number, patch: MappingPatch) =>
    nodes.setMapping(id, patch)
  )
  ipc.handle(NODES_CTRL.nodeMappingAdopt, (_e, id: number, spec: AdoptSpec) =>
    nodes.adopt(id, spec)
  )
  ipc.handle(NODES_CTRL.nodeMappingForget, (_e, id: number) => nodes.forget(id))
  ipc.handle(NODES_CTRL.nodeMappingResetNode, (_e, id: number) => nodes.resetBoard(id))
  ipc.handle(NODES_CTRL.nodeMappingReset, (_e, opts?: ResetOptions) => nodes.resetAll(opts))
  ipc.handle(NODES_CTRL.nodeMappingResetPreview, () => nodes.previewReset())
  ipc.handle(NODES_CTRL.nodeRegistry, () => nodes.registry())
  ipc.handle(NODES_CTRL.nodeMappingHide, (_e, id: number, on: boolean) => nodes.hide(id, on))
  ipc.handle(NODES_CTRL.nodeMappingAddAll, (_e, bulk: AdoptRequest[]) => nodes.addAll(bulk))
  ipc.handle(NODES_CTRL.nodeMappingUnhide, (_e, ids: number[]) => nodes.unhide(ids))
}
