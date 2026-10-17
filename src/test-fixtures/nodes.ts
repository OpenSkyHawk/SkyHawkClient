// Shared node fixtures for tests (test-only: no production code may import this folder).
//
// One set of builders for the node status rows and node models that test files used to redefine
// with their own defaults. A test that needs different defaults passes those fields explicitly,
// so what each test feeds in stays visible at the call site.
import type { NodeModel, NodeModelEntry, NodeStatus, PduOutage } from '@shared/nodes/ipc'

/** A parsed `_NODE_STATUS` row: present, healthy, kind not reported (0), 30 °C, 100 s up. */
export const nodeStatus = (nodeId: number, over: Partial<NodeStatus> = {}): NodeStatus => ({
  nodeId,
  present: true,
  boff: false,
  epvf: false,
  uptimeSec: 100,
  rxCount: 10,
  tec: 0,
  rec: 0,
  dieTempC: 30,
  overheat: false,
  degraded: false,
  faultId: 0,
  nodeKind: 0,
  ...over
})

/** A node-model entry: an online registry panel in the Center console, no power zone. */
export const modelNode = (nodeId: number, over: Partial<NodeModelEntry> = {}): NodeModelEntry => ({
  nodeId,
  name: `Node_${nodeId}`,
  console: 'Center',
  pduId: null,
  kind: 'panel',
  source: 'registry',
  availability: 'online',
  status: nodeStatus(nodeId),
  differs: false,
  ...over
})

/** The pushed node model around these entries: roster complete, nothing hidden or differing. */
export const nodeModel = (nodes: NodeModelEntry[], outages: PduOutage[] = []): NodeModel => ({
  nodes,
  outages,
  differingCount: 0,
  hidden: [],
  hiddenNodes: [],
  rosterComplete: true
})

/**
 * A v3 `_NODE_STATUS` argument (28 hex, lower case): no flags, die temperature not yet seen, and
 * `kind` (default 01, a panel group) as the last byte.
 */
export const statusRow = (nodeId: number, present = true, kind = 1): string =>
  `${nodeId.toString(16).padStart(2, '0')}${present ? '01' : '00'}0000000000000080000000${kind
    .toString(16)
    .padStart(2, '0')}`

/** The whole `_NODE_STATUS` line the Gateway sends for `statusRow`, newline included. */
export const statusLine = (nodeId: number, present = true, kind = 1): string =>
  `_NODE_STATUS ${statusRow(nodeId, present, kind)}\n`
