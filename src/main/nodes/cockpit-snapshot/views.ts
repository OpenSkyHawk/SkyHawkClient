// Per-board health, flag and readings (moved from the renderer, R3.2): what each node
// reads as on the plan, computed once per snapshot from the node model and the telemetry. The
// client applies no thresholds — a warning is always a flag a board raised itself, with one
// finding of the client's own: a board on another firmware major than the Gateway (#171).
import type { GatewayFirmware } from '@shared/gateway'
import type {
  BoardFirmware,
  NodeHealth,
  NodeModel,
  NodeModelEntry,
  NodeTelemSnapshot,
  NodeView,
  PduReadings
} from '@shared/nodes'
import { majorMismatch, reportedVersion, versionNotReported } from '../../gateway'
import { nodeFlagChips, pduAlertFlags } from '../faults'
import { newReason } from '../node-model'

/** A PDU's pages that are fresh right now. A stale page is not a reading. */
function freshReadings(t: NodeTelemSnapshot | undefined): PduReadings {
  const r: PduReadings = {}
  if (t?.rail12V && !t.rail12V.stale) r.rail12V = t.rail12V
  if (t?.rail5V && !t.rail5V.stale) r.rail5V = t.rail5V
  if (t?.status && !t.status.stale) r.status = t.status
  return r
}

/** newReason as a flag: its words in capitals, the file's name as it is spelled. */
function newReasonFlag(e: NodeModelEntry): string {
  return newReason(e).replace(/^[a-z ]+/, (w) => w.toUpperCase())
}

/** Offline wins, then bus-off, then any flag the node (or, for a PDU, its pages) raised. */
export function nodeHealth(e: NodeModelEntry, r: PduReadings = {}): NodeHealth {
  // Where it comes from, worded once (X8): `FROM NODE_IDS.md` / `NOT IN NODE_IDS.md`.
  if (e.source === 'new') return { state: 'new', flag: newReasonFlag(e) }
  if (e.availability === 'unknown') return { state: 'unknown' }
  if (e.notSeen) return { state: 'off', flag: 'NOT SEEN THIS SESSION' }
  if (e.availability === 'offline') return { state: 'off', flag: 'OFFLINE' }
  const st = e.status
  if (st?.boff) return { state: 'off', flag: 'BUS-OFF' }
  const flags = st ? nodeFlagChips(st) : []
  if (e.kind === 'pdu') flags.push(...pduAlertFlags(r))
  return flags.length ? { state: 'warn', flag: flags.join(' · ') } : { state: 'on' }
}

/** The tile and Attention flag for a board on another firmware major than the Gateway (#171). */
export const FW_MISMATCH = 'FW MISMATCH'

/** A board's release, and whether it runs another major than the Gateway (#171). */
export function boardFirmware(e: NodeModelEntry, gateway?: GatewayFirmware): BoardFirmware {
  const version = reportedVersion(e.status)
  const mismatch = majorMismatch(version, gateway)
  return {
    version,
    ...(versionNotReported(e.status) && { notReported: true as const }),
    ...(mismatch && { mismatch })
  }
}

/**
 * A mismatch is a warning on the tile and in the ring, on top of whatever the board raised: a
 * healthy board turns warn with FW_MISMATCH, a warning gains it. Offline and new boards are left
 * as they are (offline says it all; a new one isn't in your cockpit).
 */
function withFirmware(h: NodeHealth, fw: BoardFirmware): NodeHealth {
  if (!fw.mismatch) return h
  if (h.state === 'on') return { state: 'warn', flag: FW_MISMATCH }
  if (h.state === 'warn') return { state: 'warn', flag: `${h.flag} · ${FW_MISMATCH}` }
  return h
}

export function nodeViews(
  model: NodeModel,
  telemetry: NodeTelemSnapshot[],
  gateway?: GatewayFirmware
): NodeView[] {
  const telem = new Map(telemetry.map((t) => [t.nodeId, t]))
  return model.nodes.map((entry) => {
    // An offline PDU has no readings, even in the seconds before its last pages go stale.
    const readings =
      entry.kind === 'pdu' && entry.availability === 'online'
        ? freshReadings(telem.get(entry.nodeId))
        : {}
    const firmware = boardFirmware(entry, gateway)
    return {
      entry,
      health: withFirmware(nodeHealth(entry, readings), firmware),
      readings,
      noReadings: entry.kind === 'pdu' && entry.readings === 'none',
      firmware
    }
  })
}
