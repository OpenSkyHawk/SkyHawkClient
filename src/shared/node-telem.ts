// PanelBridge node telemetry decode + latest-value store (pure, no Node/Electron deps).
// Wire contract: NodeStatus.h NODE_TELEM_* / TelemPage / PduRailFlag / PduStatusFlag (generated
// into shared/firmware; reference.test asserts the decoder's protoVersion matches). Page layouts:
// FirmwarePlan/02-can-protocol.md § Node Telemetry Payload — TELEM_n (#216).
import { NODE_TELEM, PDU_RAIL_FLAGS, PDU_STATUS_FLAGS, TELEM_PAGES } from './firmware'

/** protoVersion this decoder is written for. reference.test asserts the firmware matches. */
export const SUPPORTED_TELEM_PROTO = 1

/** Reserved DCS-BIOS identifier (NODE_TELEM.msgName in the firmware reference). */
export const NODE_TELEM_MSG = NODE_TELEM.msgName

/** TelemPage ids (TELEM_PAGES). Global and append-only; 0x00 is invalid. */
export const TELEM_PAGE = TELEM_PAGES

/** PDU_RAIL_* byte 1 bits (PDU_RAIL_FLAGS). All zero = healthy. */
export const RAIL_FLAG = PDU_RAIL_FLAGS

/** PDU_STATUS byte 1 bits (PDU_STATUS_FLAGS). All zero = healthy, calibrated. */
export const PDU_FLAG = PDU_STATUS_FLAGS

/**
 * A page older than this is stale. Each PDU page refreshes every 3 s, so 10 s is three missed
 * periods — long enough that one dropped frame never flickers a reading to unknown.
 */
export const TELEM_STALE_MS = 10_000

const HEX_LEN = 18 // nodeId(2) + 8 frame bytes (16), frame bytes in wire order
const NTC_UNAVAILABLE = -0x8000 // INT16_MIN

/**
 * PDU_RAIL_12V / PDU_RAIL_5V. Averages and the minimum cover the window since this page's
 * previous PERIODIC send (3 s). A flag-change send goes out at once without restarting that
 * window, so the next periodic page still covers the full 3 s.
 */
export interface PduRailPage {
  kind: 'rail'
  page: typeof TELEM_PAGE.PDU_RAIL_12V | typeof TELEM_PAGE.PDU_RAIL_5V
  flags: number // RAIL_FLAG bits
  vAvgMv: number
  vMinMv: number // window minimum
  /** Signed: a small negative value is residual sensor offset. Use displayCurrentMa() to show it. */
  iAvgMa: number
}

/** PDU_STATUS. */
export interface PduStatusPage {
  kind: 'status'
  page: typeof TELEM_PAGE.PDU_STATUS
  flags: number // PDU_FLAG bits
  /** Board NTC temperature, °C at 0.1 resolution; null = the board reports it unavailable. */
  ntcTempC: number | null
  /** 12 V peak current over the same window as the rail averages, after the board's ~100 µs RC filter. */
  i12PeakMa: number
  /** 5 V peak current, same window and filter. */
  i5PeakMa: number
}

/** A page id this build does not know (a newer node type). Kept raw; never decoded. */
export interface UnknownTelemPage {
  kind: 'unknown'
  page: number
  /** Frame bytes 1–7 as 14 hex chars, wire order. */
  body: string
}

export type TelemPageData = PduRailPage | PduStatusPage | UnknownTelemPage
export type NodeTelem = { nodeId: number } & TelemPageData

/** True for the page ids only a PDU sends — what marks a node as a PDU. */
export function isPduPage(page: number): boolean {
  return (
    page === TELEM_PAGE.PDU_RAIL_12V ||
    page === TELEM_PAGE.PDU_RAIL_5V ||
    page === TELEM_PAGE.PDU_STATUS
  )
}

/** iAvgMa for display: residual negative offset reads as 0. */
export function displayCurrentMa(ma: number): number {
  return Math.max(0, ma)
}

/** Decode the 18-hex `_NODE_TELEM` argument; null if malformed, nodeId out of range or page 0. */
export function parseNodeTelem(hex: string): NodeTelem | null {
  if (hex.length !== HEX_LEN || !/^[0-9a-fA-F]{18}$/.test(hex)) return null
  const nodeId = parseInt(hex.slice(0, 2), 16)
  if (nodeId < 1 || nodeId > 63) return null
  const b = (i: number) => parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16) // frame byte i
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
      flags: b(1),
      vAvgMv: u16(2),
      vMinMv: u16(4),
      iAvgMa: i16(6)
    }
  }
  if (page === TELEM_PAGE.PDU_STATUS) {
    const t = i16(2)
    return {
      nodeId,
      kind: 'status',
      page,
      flags: b(1),
      ntcTempC: t === NTC_UNAVAILABLE ? null : t / 10,
      i12PeakMa: u16(4),
      i5PeakMa: u16(6)
    }
  }
  return { nodeId, kind: 'unknown', page, body: hex.slice(4).toLowerCase() }
}

/**
 * The node has a fresh PDU page (12 V, 5 V or status). This, not `live`, decides PDU readings:
 * `live` also counts pages this build does not know, which say nothing about the rails.
 */
export function hasFreshPduPage(t: NodeTelemSnapshot): boolean {
  return [t.rail12V, t.rail5V, t.status].some((p) => p !== undefined && !p.stale)
}

/** A page as last received, with its age. A stale page keeps its last values for "last known". */
export type TelemPageView<T extends TelemPageData> = T & { ageMs: number; stale: boolean }

export interface NodeTelemSnapshot {
  nodeId: number
  /** Has sent at least one PDU page since the store was reset. */
  isPdu: boolean
  rail12V?: TelemPageView<PduRailPage>
  rail5V?: TelemPageView<PduRailPage>
  status?: TelemPageView<PduStatusPage>
  /** Pages with ids this build does not know, by page id. */
  other: TelemPageView<UnknownTelemPage>[]
  /** At least one page is fresh (≤ TELEM_STALE_MS). */
  live: boolean
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
