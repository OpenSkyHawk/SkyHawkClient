// PanelBridge node telemetry decode + latest-value store (pure, no Node/Electron deps).
// Wire contract: NodeStatus.h NODE_TELEM_* / TelemPage / PduRailFlag / PduStatusFlag (generated
// into shared/firmware; reference.test asserts the decoder's protoVersion matches). Page layouts:
// FirmwarePlan/02-can-protocol.md § Node Telemetry Payload — TELEM_n (#216).
import {
  MAX_NODE_ID,
  NODE_TELEM,
  NODE_TELEM_FIELD,
  NODE_TELEM_ROW_BYTES,
  NTC_TEMP_UNAVAILABLE,
  PDU_RAIL_FIELD,
  PDU_STATUS_FIELD,
  TELEM_PAGES
} from '@shared/firmware'
import type { NodeTelem, NodeTelemSnapshot, TelemPageData } from '@shared/nodes'

/** protoVersion this decoder is written for. reference.test asserts the firmware matches. */
export const SUPPORTED_TELEM_PROTO = 1

/** Reserved DCS-BIOS identifier (NODE_TELEM.msgName in the firmware reference). */
export const NODE_TELEM_MSG = NODE_TELEM.msgName

/** TelemPage ids (TELEM_PAGES). Global and append-only; 0x00 is invalid. */
export const TELEM_PAGE = TELEM_PAGES

/**
 * A page older than this is stale. Each PDU page refreshes every 3 s (one TELEM_n frame per
 * TELEM_PERIOD_MS in shared/firmware, rotating through three pages), so 10 s is three missed
 * periods — long enough that one dropped frame never flickers a reading to unknown. The window is
 * client policy; reference.test pins the firmware period it was chosen against.
 */
export const TELEM_STALE_MS = 10_000

// NODE_TELEM_ROW_BYTES (9) as hex, 18 chars: nodeId + the 8 frame bytes in wire order.
const HEX_LEN = NODE_TELEM_ROW_BYTES * 2

/** True for the page ids only a PDU sends — what marks a node as a PDU. */
function isPduPage(page: number): boolean {
  return (
    page === TELEM_PAGE.PDU_RAIL_12V ||
    page === TELEM_PAGE.PDU_RAIL_5V ||
    page === TELEM_PAGE.PDU_STATUS
  )
}

/** Decode the 18-hex `_NODE_TELEM` argument; null if malformed, nodeId out of range or page 0. */
export function parseNodeTelem(hex: string): NodeTelem | null {
  if (hex.length !== HEX_LEN || !/^[0-9a-fA-F]+$/.test(hex)) return null
  // Row byte `at` (NODE_TELEM_FIELD offset): hex index 2 × at.
  const row = (at: number) => parseInt(hex.slice(at * 2, at * 2 + 2), 16)
  const nodeId = row(NODE_TELEM_FIELD.ID)
  if (nodeId < 1 || nodeId > MAX_NODE_ID) return null
  const b = (i: number) => row(NODE_TELEM_FIELD.FRAME + i) // frame byte i; byte 0 is the page
  const u16 = (i: number) => b(i) | (b(i + 1) << 8) // little-endian
  const i16 = (i: number) => {
    const v = u16(i)
    return v >= 0x8000 ? v - 0x10000 : v
  }
  const page = b(0)
  if (page === 0) return null
  if (page === TELEM_PAGE.PDU_RAIL_12V || page === TELEM_PAGE.PDU_RAIL_5V) {
    return {
      nodeId,
      kind: 'rail',
      page,
      flags: b(PDU_RAIL_FIELD.FLAGS),
      vAvgMv: u16(PDU_RAIL_FIELD.V_AVG_MV),
      vMinMv: u16(PDU_RAIL_FIELD.V_MIN_MV),
      iAvgMa: i16(PDU_RAIL_FIELD.I_AVG_MA)
    }
  }
  if (page === TELEM_PAGE.PDU_STATUS) {
    const t = i16(PDU_STATUS_FIELD.NTC_TEMP_DC)
    return {
      nodeId,
      kind: 'status',
      page,
      flags: b(PDU_STATUS_FIELD.FLAGS),
      ntcTempC: t === NTC_TEMP_UNAVAILABLE ? null : t / 10, // the int16 sentinel, 0x8000 on the wire
      i12PeakMa: u16(PDU_STATUS_FIELD.I12_PEAK_MA),
      i5PeakMa: u16(PDU_STATUS_FIELD.I5_PEAK_MA)
    }
  }
  // Frame bytes 1–7: everything after the page byte.
  return {
    nodeId,
    kind: 'unknown',
    page,
    body: hex.slice((NODE_TELEM_FIELD.FRAME + 1) * 2).toLowerCase()
  }
}

/**
 * The node has a fresh PDU page (12 V, 5 V or status). This, not `live`, decides PDU readings:
 * `live` also counts pages this build does not know, which say nothing about the rails.
 */
export function hasFreshPduPage(t: NodeTelemSnapshot): boolean {
  return [t.rail12V, t.rail5V, t.status].some((p) => p !== undefined && !p.stale)
}

/** iAvgMa for display: residual negative offset reads as 0. */
export function displayCurrentMa(ma: number): number {
  return Math.max(0, ma)
}

interface Entry {
  data: TelemPageData
  at: number
}

/**
 * Latest value per (nodeId, page) with its arrival time. Telemetry is pushed with no request, no
 * cache and no end marker, so the store's only notion of "gone" is age: a page goes stale after
 * TELEM_STALE_MS, and a node with no fresh page is not live.
 */
export class NodeTelemStore {
  private nodes = new Map<number, Map<number, Entry>>()
  private dirty = false
  private staleKey = ''

  reset(): void {
    this.nodes.clear()
    this.dirty = true
    this.staleKey = ''
  }

  apply(t: NodeTelem, now: number): void {
    const { nodeId, ...data } = t
    let pages = this.nodes.get(nodeId)
    if (!pages) this.nodes.set(nodeId, (pages = new Map()))
    pages.set(data.page, { data, at: now })
    this.dirty = true
  }

  snapshot(now: number): NodeTelemSnapshot[] {
    const out: NodeTelemSnapshot[] = []
    for (const [nodeId, pages] of [...this.nodes].sort((a, b) => a[0] - b[0])) {
      const snap: NodeTelemSnapshot = { nodeId, isPdu: false, other: [], live: false }
      for (const [page, e] of [...pages].sort((a, b) => a[0] - b[0])) {
        const ageMs = now - e.at
        const stale = ageMs > TELEM_STALE_MS
        if (!stale) snap.live = true
        if (isPduPage(page)) snap.isPdu = true
        const d = e.data
        if (d.kind === 'rail') {
          const v = { ...d, ageMs, stale }
          if (d.page === TELEM_PAGE.PDU_RAIL_12V) snap.rail12V = v
          else snap.rail5V = v
        } else if (d.kind === 'status') {
          snap.status = { ...d, ageMs, stale }
        } else {
          snap.other.push({ ...d, ageMs, stale })
        }
      }
      out.push(snap)
    }
    return out
  }

  /**
   * True once since the last call if a page arrived or any page crossed into / out of stale.
   * Ageing alone changes nothing a reader acts on, so it does not count — that keeps an idle
   * store from emitting at all.
   */
  takeChanged(now: number): boolean {
    const key = this.staleIds(now)
    const changed = this.dirty || key !== this.staleKey
    this.dirty = false
    this.staleKey = key
    return changed
  }

  private staleIds(now: number): string {
    const ids: string[] = []
    for (const [nodeId, pages] of this.nodes) {
      for (const [page, e] of pages) if (now - e.at > TELEM_STALE_MS) ids.push(`${nodeId}:${page}`)
    }
    return ids.sort().join(',')
  }
}
