// PanelBridge node-status decode + roster (pure, no Node/Electron deps).
// Wire contract: NodeStatus.h NODE_STATUS_* (generated into shared/firmware; reference.test
// asserts the decoder's protoVersion matches).
import {
  DIE_TEMP_UNAVAILABLE,
  GATEWAY_NODE_ID,
  HB_ESR_REC_SHIFT,
  HB_ESR_TEC_SHIFT,
  HEARTBEAT_FLAGS,
  MAX_NODE_ID,
  NODE_HEALTH_FLAGS,
  NODE_KINDS,
  NODE_STATUS,
  NODE_STATUS_FIELD,
  NODE_STATUS_ROW_BYTES
} from '@shared/firmware'
import type { NodeSeen, NodeStatus } from '@shared/nodes'
// Deep import, not '../gateway': the gateway index reaches back into nodes through DeviceLink
// until R2.2 splits it, so going through the index would close an import cycle.
import { encodeExportFrame } from '../gateway/link-framing'

/** protoVersion this decoder is written for. reference.test asserts the firmware matches. */
export const SUPPORTED_NODE_PROTO = 3

/** Reserved DCS-BIOS identifiers (NODE_STATUS in the firmware reference). */
export const NODE_MSG = NODE_STATUS.msgName
export const NODE_END_MSG = NODE_STATUS.endMsgName
export const NODE_REQ_ADDR = NODE_STATUS.reqAddress

/** hFlags bit masks (NODE_HEALTH_FLAGS in the firmware reference). */
export const HFLAG_OVERHEAT = NODE_HEALTH_FLAGS.OVERHEAT
export const HFLAG_DEGRADED = NODE_HEALTH_FLAGS.DEGRADED

/** HEALTH_n board kind, as _NODE_STATUS v3 forwards it (NODE_KINDS in the firmware reference). */
export const NODE_KIND = NODE_KINDS

/**
 * The bridge's own NODE_ID (GATEWAY_NODE_ID in the firmware reference): PanelBridge is the CAN
 * master at address 0, and since v3 every roster reply starts with its row. That row is this
 * client's own link, never a cockpit node. (An address, not a board type: a node's type is only
 * ever what it reports.)
 */
export const BRIDGE_NODE_ID = GATEWAY_NODE_ID

// proto v3: NODE_STATUS_ROW_BYTES (14) as hex, 28 chars — v2 plus the node's reported board kind
// (#344). Field offsets: NODE_STATUS_FIELD; each byte is two hex chars.
const HEX_LEN = NODE_STATUS_ROW_BYTES * 2
// The legacy v2 row (26 hex), detected client-side only to say "this bridge is too old". The
// firmware no longer describes it, so it has nothing to sync from: it stays a client constant.
const V2_HEX_LEN = 26

/** Decode the 28-hex v3 `_NODE_STATUS` argument; null if malformed / nodeId out of range. */
export function parseNodeStatus(hex: string): NodeStatus | null {
  if (hex.length !== HEX_LEN || !/^[0-9a-fA-F]+$/.test(hex)) return null
  const F = NODE_STATUS_FIELD
  // A field at byte offset `at`, `bytes` wide: hex index 2 × at, most-significant byte first.
  const f = (at: number, bytes: number) => parseInt(hex.slice(at * 2, (at + bytes) * 2), 16)
  const nodeId = f(F.ID, 1)
  if (nodeId > MAX_NODE_ID) return null
  const flags = f(F.HB_FLAGS, 1)
  const esr = f(F.ESR, 2)
  const traw = f(F.DIE_TEMP_C, 1) // int8 two's-complement
  const temp = traw < 128 ? traw : traw - 256
  const hf = f(F.HEALTH_FLAGS, 1) // FAULT_MASK (the next byte) is reserved/unused; skipped
  return {
    nodeId,
    present: f(F.PRESENT, 1) === 1,
    boff: (flags & HEARTBEAT_FLAGS.BOFF) !== 0,
    epvf: (flags & HEARTBEAT_FLAGS.EPVF) !== 0,
    uptimeSec: f(F.UPTIME, 2),
    rxCount: f(F.RX_COUNT, 2),
    tec: (esr >> HB_ESR_TEC_SHIFT) & 0xff,
    rec: (esr >> HB_ESR_REC_SHIFT) & 0xff,
    dieTempC: temp === DIE_TEMP_UNAVAILABLE ? null : temp, // the int8 sentinel, -128 (0x80)
    overheat: (hf & HFLAG_OVERHEAT) !== 0,
    degraded: (hf & HFLAG_DEGRADED) !== 0,
    faultId: f(F.FAULT_ID, 1),
    nodeKind: f(F.NODE_KIND, 1)
  }
}

/**
 * A v2 (pre-#344) row: well-formed, but this client needs v3. The caller says so loudly rather than
 * dropping it like a corrupt line, since every row from that bridge would be lost the same way.
 */
export function isLegacyNodeStatus(hex: string): boolean {
  return hex.length === V2_HEX_LEN && /^[0-9a-fA-F]+$/.test(hex)
}

/**
 * A node-status line with any junk in front of it removed. Right after a PanelBridge reset the
 * first line can carry UART noise (seen: `_\xfe_NODE_STATUS …`); since v3 that is the node-0 row.
 * Only a prefix holding a non-printable byte is cut, so a real identifier that merely contains
 * `_NODE_` is never mangled; anything else comes back unchanged.
 */
export function cleanNodeLine(line: string): string {
  const at = line.indexOf('_NODE_')
  if (at <= 0) return line
  return /[^\x20-\x7e]/.test(line.slice(0, at)) ? line.slice(at) : line
}

/** A DCS-BIOS export frame that asks PanelBridge for the full node roster. */
export function nodeRosterRequest(): Uint8Array {
  return encodeExportFrame(NODE_REQ_ADDR, 1)
}

/**
 * How long after a roster request a `_NODE_STATUS` still counts as part of its reply. The bridge
 * answers at once (a burst of lines at 250 kbaud); a second is generous.
 */
export const ROSTER_REPLY_MS = 1000

/**
 * Tracks every node seen since reset. Bare messages are live deltas; a request/boot
 * burst ends with `_NODE_STATUS_END`, after which nodes absent from the burst are
 * marked offline (present=false) — they STAY in the roster (shown red) rather than
 * being removed, so a panel that drops off is still visible.
 */
export class NodeRoster {
  private nodes = new Map<number, NodeStatus>()
  private seen = new Map<number, NodeSeen>()
  private burst: NodeStatus[] = []
  /** When the pending roster request went out; cleared by its `_NODE_STATUS_END`. */
  private burstAt?: number
  private completeAt?: number
  private dirty = false

  reset(): void {
    this.nodes.clear()
    this.seen.clear()
    this.burst = []
    this.burstAt = undefined
    this.completeAt = undefined
    this.dirty = true
  }

  /** Call when a roster request is sent, so the reply burst is isolated from prior deltas. */
  beginBurst(now = Date.now()): void {
    this.burst = []
    this.burstAt = now
  }

  /**
   * A status inside the reply window of a pending request is part of the roster reply. Bounded,
   * so a bridge that never sends `_NODE_STATUS_END` cannot leave every later delta labelled as a
   * late roster find (which would widen PDU-offline grouping for good).
   */
  private inReply(now: number): boolean {
    return (
      this.burstAt !== undefined && now >= this.burstAt && now - this.burstAt <= ROSTER_REPLY_MS
    )
  }

  /** Feed one parsed DCS-BIOS command (name + remaining arg text). */
  applyMessage(name: string, arg: string, now = Date.now()): void {
    if (name === NODE_MSG) {
      const ns = parseNodeStatus(arg.trim())
      if (!ns) return
      this.burst.push(ns)
      const wasPresent = this.nodes.get(ns.nodeId)?.present ?? true
      this.nodes.set(ns.nodeId, ns) // keep absent nodes too; present flag carries state
      const seen = this.seen.get(ns.nodeId) ?? { firstSeenAt: now }
      if (ns.present) this.seen.set(ns.nodeId, { firstSeenAt: seen.firstSeenAt, reportedAt: now })
      else if (wasPresent || seen.offlineAt === undefined) {
        this.seen.set(ns.nodeId, {
          ...seen,
          offlineAt: now,
          offlineVia: this.inReply(now) ? 'roster' : 'delta'
        })
      }
      this.dirty = true
    } else if (name === NODE_END_MSG) {
      // Nodes not in this burst went silent → mark offline, but keep them visible.
      const inBurst = new Set(this.burst.map((n) => n.nodeId))
      for (const [id, node] of this.nodes) {
        if (!inBurst.has(id) && node.present) {
          this.nodes.set(id, { ...node, present: false })
          const seen = this.seen.get(id) ?? { firstSeenAt: now }
          this.seen.set(id, { ...seen, offlineAt: now, offlineVia: 'roster' })
        }
      }
      this.burst = []
      this.burstAt = undefined
      this.completeAt ??= now
      this.dirty = true
    }
  }

  snapshot(): NodeStatus[] {
    return [...this.nodes.values()].sort((a, b) => a.nodeId - b.nodeId)
  }

  /** First-seen / offline timing per node, in memory only (cleared by reset). */
  seenInfo(): ReadonlyMap<number, NodeSeen> {
    return this.seen
  }

  /** When the first complete roster (first `_NODE_STATUS_END`) since reset arrived. */
  rosterCompleteAt(): number | undefined {
    return this.completeAt
  }

  /** True once since the last call if the roster changed (drives throttled emits). */
  takeDirty(): boolean {
    const d = this.dirty
    this.dirty = false
    return d
  }
}
