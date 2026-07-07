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
  name?: string // panel name from the NODE_IDS registry (filled in main)
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
 * Tracks every node seen since reset. Bare messages are live deltas; a request/boot
 * burst ends with `_NODE_STATUS_END`, after which nodes absent from the burst are
 * marked offline (present=false) — they STAY in the roster (shown red) rather than
 * being removed, so a panel that drops off is still visible.
 */
export class NodeRoster {
  private nodes = new Map<number, NodeStatus>()
  private burst: NodeStatus[] = []
  private dirty = false

  reset(): void {
    this.nodes.clear()
    this.burst = []
    this.dirty = true
  }

  /** Call when a roster request is sent, so the reply burst is isolated from prior deltas. */
  beginBurst(): void {
    this.burst = []
  }

  /** Feed one parsed DCS-BIOS command (name + remaining arg text). */
  applyMessage(name: string, arg: string): void {
    if (name === NODE_MSG) {
      const ns = parseNodeStatus(arg.trim())
      if (!ns) return
      this.burst.push(ns)
      this.nodes.set(ns.nodeId, ns) // keep absent nodes too; present flag carries state
      this.dirty = true
    } else if (name === NODE_END_MSG) {
      // Nodes not in this burst went silent → mark offline, but keep them visible.
      const seen = new Set(this.burst.map((n) => n.nodeId))
      for (const [id, node] of this.nodes) {
        if (!seen.has(id) && node.present) this.nodes.set(id, { ...node, present: false })
      }
      this.burst = []
      this.dirty = true
    }
  }

  snapshot(): NodeStatus[] {
    return [...this.nodes.values()].sort((a, b) => a.nodeId - b.nodeId)
  }

  /** True once since the last call if the roster changed (drives throttled emits). */
  takeDirty(): boolean {
    const d = this.dirty
    this.dirty = false
    return d
  }
}
