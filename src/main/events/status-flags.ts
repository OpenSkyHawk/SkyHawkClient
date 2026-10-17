// The node status-flag vocabulary (pure, no Node/Electron deps): the heartbeat / health flags and
// fault labels that node rows and the Gateway's own row share (arch-phase0-v2 OQ4).
import type { EventSeverity } from '@shared/events'
import type { NodeStatus } from '@shared/nodes'

export type StatusFlag = 'boff' | 'epvf' | 'degraded' | 'overheat'

/** A node's own heartbeat / health flags, as every row and the Gateway (#94) name them. */
export const STATUS_FLAGS: { key: StatusFlag; label: string; severity: EventSeverity }[] = [
  { key: 'boff', label: 'bus-off', severity: 'error' },
  { key: 'epvf', label: 'error-passive', severity: 'warn' },
  { key: 'degraded', label: 'degraded', severity: 'warn' },
  { key: 'overheat', label: 'overheat', severity: 'warn' }
]

/** The fault-dictionary label, else `Fault N`. */
export function faultLabel(n: Pick<NodeStatus, 'faultId' | 'faultLabel'>): string {
  return n.faultLabel ?? `Fault ${n.faultId}`
}
