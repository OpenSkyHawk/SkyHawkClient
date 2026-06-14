// PanelBridge node-status decode + roster (pure, no Node/Electron deps).
// Wire contract: HIDControls.h NODE_STATUS_* (mirrored in
// src/main/reference/node-status.generated.ts; reference.test asserts they match).
import { encodeExportFrame } from './dcsbios'

/** protoVersion this decoder is written for. reference.test asserts the firmware matches. */
export const SUPPORTED_NODE_PROTO = 1

/** Reserved DCS-BIOS identifiers (must equal node-status.generated.ts). */
export const NODE_MSG = '_NODE_STATUS'
export const NODE_END_MSG = '_NODE_STATUS_END'
export const NODE_REQ_ADDR = 0x86fe

const HEX_LEN = 18 // nodeId(2) present(2) flags(2) uptime(4) rxCount(4) esr(4)

export interface NodeStatus {
  nodeId: number // 1..63
  present: boolean
  boff: boolean // CAN bus-off
  epvf: boolean // CAN error-passive
  uptimeSec: number // wraps ~18 h
  rxCount: number // node-accepted CAN RX count
  tec: number // transmit error counter (esr low byte)
  rec: number // receive error counter (esr high byte)
}

/** Decode the 18-hex `_NODE_STATUS` argument; null if malformed / nodeId out of range. */
export function parseNodeStatus(hex: string): NodeStatus | null {
  if (hex.length !== HEX_LEN || !/^[0-9a-fA-F]{18}$/.test(hex)) return null
  const f = (i: number, n: number) => parseInt(hex.slice(i, i + n), 16)
  const nodeId = f(0, 2)
  if (nodeId < 1 || nodeId > 63) return null
  const flags = f(4, 2)
  const esr = f(14, 4)
  return {
    nodeId,
    present: f(2, 2) === 1,
    boff: (flags & 0x01) !== 0,
    epvf: (flags & 0x02) !== 0,
    uptimeSec: f(6, 4),
    rxCount: f(10, 4),
    tec: esr & 0xff,
    rec: (esr >> 8) & 0xff
  }
}

/** A DCS-BIOS export frame that asks PanelBridge for the full node roster. */
export function nodeRosterRequest(): Uint8Array {
  return encodeExportFrame(NODE_REQ_ADDR, 1)
}

/**
 * Tracks the present node set from the `_NODE_STATUS` stream. Bare messages are
 * live deltas (apply immediately); a request/boot burst ends with `_NODE_STATUS_END`,
 * after which nodes absent from that burst are pruned (authoritative roster).
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
      if (ns.present) this.nodes.set(ns.nodeId, ns)
      else this.nodes.delete(ns.nodeId)
      this.dirty = true
    } else if (name === NODE_END_MSG) {
      const present = new Set(this.burst.filter((n) => n.present).map((n) => n.nodeId))
      for (const id of [...this.nodes.keys()]) if (!present.has(id)) this.nodes.delete(id)
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
