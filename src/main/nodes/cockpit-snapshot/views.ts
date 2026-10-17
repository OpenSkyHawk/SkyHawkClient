// Per-board health, flag and readings (moved from the renderer's cockpit.ts, R3.2): what each node
// reads as on the plan, computed once per snapshot from the node model and the telemetry. The
// client applies no thresholds — a warning is always a flag a board raised itself.
import type {
  NodeHealth,
  NodeModel,
  NodeModelEntry,
  NodeTelemSnapshot,
  NodeView,
  PduReadings
} from '@shared/nodes'
import { nodeFaultTag } from '@shared/nodes/legacy-rules'
import { pduAlertFlags } from '../faults'

/** A PDU's pages that are fresh right now. A stale page is not a reading. */
export function freshReadings(t: NodeTelemSnapshot | undefined): PduReadings {
  const r: PduReadings = {}
  if (t?.rail12V && !t.rail12V.stale) r.rail12V = t.rail12V
  if (t?.rail5V && !t.rail5V.stale) r.rail5V = t.rail5V
  if (t?.status && !t.status.stale) r.status = t.status
  return r
}

/** Offline wins, then bus-off, then any flag the node (or, for a PDU, its pages) raised. */
export function nodeHealth(e: NodeModelEntry, r: PduReadings = {}): NodeHealth {
  if (e.source === 'new') return { state: 'new', flag: 'NOT IN REGISTRY' }
  if (e.availability === 'unknown') return { state: 'unknown' }
  if (e.notSeen) return { state: 'off', flag: 'NOT SEEN THIS SESSION' }
  if (e.availability === 'offline') return { state: 'off', flag: 'OFFLINE' }
  const st = e.status
  if (st?.boff) return { state: 'off', flag: 'BUS-OFF' }
  const flags: string[] = []
  if (st?.degraded) flags.push(nodeFaultTag(st))
  if (st?.overheat) flags.push('OVERHEAT')
  if (st?.epvf) flags.push('ERR-PASSIVE')
  if (e.kind === 'pdu') flags.push(...pduAlertFlags(r))
  return flags.length ? { state: 'warn', flag: flags.join(' · ') } : { state: 'on' }
}

export function nodeViews(model: NodeModel, telemetry: NodeTelemSnapshot[]): NodeView[] {
  const telem = new Map(telemetry.map((t) => [t.nodeId, t]))
  return model.nodes.map((entry) => {
    // An offline PDU has no readings, even in the seconds before its last pages go stale.
    const readings =
      entry.kind === 'pdu' && entry.availability === 'online'
        ? freshReadings(telem.get(entry.nodeId))
        : {}
    return {
      entry,
      health: nodeHealth(entry, readings),
      readings,
      noReadings: entry.kind === 'pdu' && entry.readings === 'none'
    }
  })
}
