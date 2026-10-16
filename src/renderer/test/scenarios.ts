// Scenario builders for component tests: main-side state at today's push level (skyhawk-mock.ts).
// One place for them, on top of the shared node fixtures, so every component test describes the
// world the same way. Each builder states its defaults; a test passes whatever differs.
import { gatewayStatus, type GatewayStatus } from '@shared/gateway'
import type { DeviceState, DeviceStatus } from '@shared/ipc'
import type { NodeModel, NodeModelEntry, PduOutage } from '@shared/node-rules'
import { NODE_KIND, type NodeStatus } from '@shared/nodes'
import { modelNode, nodeModel, nodeStatus } from '../../test-fixtures/nodes'

export { modelNode, nodeModel, nodeStatus }

// ── device link (`device:status`) ───────────────────────────────────────────

export const PORT = '/dev/cu.usbmodem1'

/** The device link in `state`; connected and error carry the port, as main sends them. */
export function link(state: DeviceState, over: Partial<DeviceStatus> = {}): DeviceStatus {
  const port = state === 'connected' || state === 'error' ? { portPath: PORT } : {}
  return { state, ...port, ...over }
}

/** Connected, with the Gateway's own health when given. */
export const connected = (gateway?: GatewayStatus): DeviceStatus =>
  link('connected', gateway ? { gateway } : {})

// ── the Gateway's own health (`device:status.gateway`), from main's own builder ─────────────

/**
 * What main computes from the Gateway's node-0 status row (shared/gateway.ts gatewayStatus): its
 * health frame has arrived (kind 03), 42 °C, plus `row` (e.g. `{ boff: true }`).
 */
export function gateway(row: Partial<NodeStatus> = {}): GatewayStatus {
  const st = nodeStatus(0, { nodeKind: NODE_KIND.BRIDGE, dieTempC: 42, ...row })
  return gatewayStatus(st, false)!
}

/** A roster request went unanswered for 5 s while the port was open. */
export const gatewayNotResponding = (): GatewayStatus => gatewayStatus(undefined, true)!

// ── node model entries (`nodes:model`) ──────────────────────────────────────

/** NODE_IDS.md consoles come from the name prefix: `Right_Navigation` → `Right`. */
const consoleOf = (name: string) => /^(Left|Center|Right)/.exec(name)?.[1] ?? 'Center'

/** A registry panel group in your cockpit: online, healthy, reported kind 01, no power zone. */
export const panel = (nodeId: number, name: string, over: Partial<NodeModelEntry> = {}) =>
  modelNode(nodeId, {
    name,
    console: consoleOf(name),
    identified: 'panel',
    status: nodeStatus(nodeId, { nodeKind: NODE_KIND.PANEL_GROUP }),
    ...over
  })

/** A registry PDU in your cockpit: online, healthy, reported kind 02, no fresh pages. */
export const pdu = (nodeId: number, name: string, over: Partial<NodeModelEntry> = {}) =>
  modelNode(nodeId, {
    name,
    console: consoleOf(name),
    kind: 'pdu',
    identified: 'pdu',
    readings: 'none',
    status: nodeStatus(nodeId, { nodeKind: NODE_KIND.PDU }),
    ...over
  })

/** The roster lists it gone, at `at`. */
export const offline = (at?: number): Partial<NodeModelEntry> => ({
  availability: 'offline',
  offlineVia: 'roster',
  ...(at !== undefined && { offlineAt: at })
})

/** Remembered from an earlier session, missing from this session's first complete roster. */
export const notSeen = (lastSeenAt?: number): Partial<NodeModelEntry> => ({
  availability: 'offline',
  notSeen: true,
  status: undefined,
  ...(lastSeenAt !== undefined && { lastSeenAt })
})

/** No complete roster yet and it hasn't reported: availability unknown. */
export const noStatusYet = (): Partial<NodeModelEntry> => ({
  availability: 'unknown',
  status: undefined
})

/**
 * A board on the bus that isn't in your cockpit: online since `firstSeenAt`, nothing reported
 * about its kind (0) unless `over` says so.
 */
export const newBoard = (nodeId: number, firstSeenAt: number, over: Partial<NodeModelEntry> = {}) =>
  modelNode(nodeId, {
    name: `Node ${nodeId}`,
    console: null,
    source: 'new',
    firstSeenAt,
    reportedAt: firstSeenAt,
    ...over
  })

/** A PDU outage: the PDU and the fed boards that dropped with it. */
export const outage = (pduId: number, nodeIds: number[], fedCount: number, at = 0): PduOutage => ({
  pduId,
  nodeIds,
  fedCount,
  at
})

/** The model main pushes around these entries; roster complete unless `over` says otherwise. */
export const model = (
  nodes: NodeModelEntry[],
  outages: PduOutage[] = [],
  over: Partial<NodeModel> = {}
): NodeModel => ({ ...nodeModel(nodes, outages), ...over })
