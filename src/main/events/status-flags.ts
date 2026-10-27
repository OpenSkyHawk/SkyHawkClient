// The node status-flag vocabulary (pure, no Node/Electron deps): the heartbeat / health flags and
// fault labels that node rows and the Gateway's own row share (arch-phase0-v2 OQ4).
import type { EventSeverity } from '@shared/events'
import type { NodeStatus } from '@shared/nodes'

export type StatusFlag = 'boff' | 'epvf' | 'degraded' | 'overheat'

/**
 * A node's own heartbeat / health flags, as every row and the Gateway (#94) name them: the label and
 * the severity, by flag. No order here: the order a node's flags are named in is nodes/faults.ts's
 * (NODE_FLAG_ORDER), the Gateway's own is gateway-health's.
 */
export const STATUS_FLAGS: Record<
  StatusFlag,
  { key: StatusFlag; label: string; severity: EventSeverity }
> = {
  boff: { key: 'boff', label: 'bus-off', severity: 'error' },
  epvf: { key: 'epvf', label: 'error-passive', severity: 'warn' },
  degraded: { key: 'degraded', label: 'degraded', severity: 'warn' },
  overheat: { key: 'overheat', label: 'overheat', severity: 'warn' }
}

/** The fault-dictionary label, else `Unknown fault (N)` for a code this client has no label for (#183). */
export function faultLabel(n: Pick<NodeStatus, 'faultId' | 'faultLabel'>): string {
  return n.faultLabel ?? `Unknown fault (${n.faultId})`
}
