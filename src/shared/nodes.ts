// PanelBridge node-status decode + roster (pure, no Node/Electron deps).
// Wire contract: NodeStatus.h NODE_STATUS_* (mirrored in
// src/main/reference/node-status.generated.ts; reference.test asserts they match).
import { encodeExportFrame } from './dcsbios'

/** protoVersion this decoder is written for. reference.test asserts the firmware matches. */
export const SUPPORTED_NODE_PROTO = 2

/** Reserved DCS-BIOS identifiers (must equal node-status.generated.ts). */
export const NODE_MSG = '_NODE_STATUS'
export const NODE_END_MSG = '_NODE_STATUS_END'
export const NODE_REQ_ADDR = 0x86fe

/** hFlags bit masks (must equal NODE_HEALTH_FLAGS in node-status.generated.ts; reference.test checks). */
export const HFLAG_OVERHEAT = 0x01
export const HFLAG_DEGRADED = 0x02

// proto v2: 26 hex — the v1 fields plus the node's cached HEALTH_n telemetry.
const HEX_LEN = 26 // nodeId(2) present(2) flags(2) uptime(4) rxCount(4) esr(4) dieTempC(2) hFlags(2) faultMask(2) faultId(2)

export interface NodeStatus {
  nodeId: number // 1..63
  present: boolean
  boff: boolean // CAN bus-off
  epvf: boolean // CAN error-passive
  uptimeSec: number // wraps ~18 h
  rxCount: number // node-accepted CAN RX count
  tec: number // transmit error counter (esr low byte)
  rec: number // receive error counter (esr high byte)
  // HEALTH_n telemetry (proto v2). Uncalibrated internal MCU sensor — die temp, not ambient.
  dieTempC: number | null // whole °C; null = not yet seen (sentinel 0x80)
  overheat: boolean // hFlags bit0 (opt-in firmware trip; usually false)
  degraded: boolean // hFlags bit1 — a registered FaultSource reports non-NONE (rendered by #40, parsed here)
  faultId: number // fault code, 0 = none; label via NODE_FAULT_CODES (node-status.generated.ts), render #40
  // Fault-dictionary enrichment — filled in main from NODE_FAULT_CODES; undefined when healthy or an
  // unknown/reserved id (the decoder passes any faultId through). Renderer falls back to `Fault N`.
  faultAbbr?: string
  faultLabel?: string
  faultDesc?: string
}

/** Short degraded-badge tag — the fault abbr, or `Fault N` for an unknown/reserved id. */
export function nodeFaultTag(n: NodeStatus): string {
  return n.faultAbbr ?? `Fault ${n.faultId}`
}

/** Decode the 26-hex `_NODE_STATUS` argument; null if malformed / nodeId out of range. */
export function parseNodeStatus(hex: string): NodeStatus | null {
  if (hex.length !== HEX_LEN || !/^[0-9a-fA-F]{26}$/.test(hex)) return null
  const f = (i: number, n: number) => parseInt(hex.slice(i, i + n), 16)
  const nodeId = f(0, 2)
  if (nodeId < 1 || nodeId > 63) return null
  const flags = f(4, 2)
  const esr = f(14, 4)
  const traw = f(18, 2) // int8 two's-complement; 0x80 = not-yet-seen sentinel
  const hf = f(20, 2) // byte 22 (faultMask) reserved/unused; skipped
  return {
    nodeId,
    present: f(2, 2) === 1,
    boff: (flags & 0x01) !== 0,
    epvf: (flags & 0x02) !== 0,
    uptimeSec: f(6, 4),
    rxCount: f(10, 4),
    tec: esr & 0xff,
    rec: (esr >> 8) & 0xff,
    dieTempC: traw === 0x80 ? null : traw < 128 ? traw : traw - 256,
    overheat: (hf & HFLAG_OVERHEAT) !== 0,
    degraded: (hf & HFLAG_DEGRADED) !== 0,
    faultId: f(24, 2)
  }
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

/** When a node was first seen and, while it is offline, when and how it went offline. */
export interface NodeSeen {
  firstSeenAt: number
  /** Reported present at least once since reset. A board that was never connected has not. */
  everPresent?: true
  /** Set while offline: when the client learned of it. */
  offlineAt?: number
  /**
   * 'delta' = a live `_NODE_STATUS` pushed on the transition (arrives ~3 s after the node goes
   * silent, the bridge's heartbeat timeout). 'roster' = found by a roster reply, so the real
   * transition happened up to one poll earlier.
   */
  offlineVia?: 'delta' | 'roster'
}

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
      if (ns.present) this.seen.set(ns.nodeId, { firstSeenAt: seen.firstSeenAt, everPresent: true })
      else if (wasPresent || seen.offlineAt === undefined) {
        this.seen.set(ns.nodeId, {
          firstSeenAt: seen.firstSeenAt,
          ...(seen.everPresent && { everPresent: true }),
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
          this.seen.set(id, {
            firstSeenAt: seen.firstSeenAt,
            ...(seen.everPresent && { everPresent: true }),
            offlineAt: now,
            offlineVia: 'roster'
          })
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
