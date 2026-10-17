// Node events (#64): the change events the event log gets from the boards' own reports
// (`_NODE_STATUS`, `_NODE_TELEM`). Pure, no Node/Electron deps. The client never applies a
// threshold, so every alert here is a flag a board raised itself.
import type { EventSeverity, LogEventInput } from '@shared/events'
import type { NodeStatus, NodeTelem } from '@shared/nodes'
import { faultLabel } from '../events'
import { NODE_FLAGS, PDU_STATUS_FLAGS, RAIL_FLAGS, railReading, TEMP_FLAGS } from './faults'
import { BRIDGE_NODE_ID, NODE_END_MSG, ROSTER_REPLY_MS } from './node-status-wire'
import { TELEM_PAGE } from './node-telem'

/** What the node mapping says about an id, as the tracker needs it. */
export interface NodeLookup {
  /** Effective name; `Node <id>` when the id has none. */
  name(nodeId: number): string
  /** Neither in the registry nor adopted, and identified as something adoptable: news. */
  isNew(nodeId: number): boolean
  /** Not in your cockpit (not added, not adopted), whatever it has identified as. */
  unmapped(nodeId: number): boolean
  /** In NODE_IDS.md — a new one is waiting to be added, pre-filled (#93). Absent = never. */
  inRegistry?(nodeId: number): boolean
}

/**
 * Turns the node reports the client receives into change events.
 *
 * Keeps its own last-seen state per node, so a roster poll that repeats what is already known
 * produces nothing. After every port open (`reset`) the first roster is a baseline: nodes found
 * online there are one "N nodes online" row, not N; problems already present (offline, a flag
 * raised) still get their own rows, since nothing else would show them.
 */
export class NodeEventTracker {
  private prev = new Map<number, NodeStatus>()
  private pages = new Map<string, number>()
  private baseline = true
  private baselineAt?: number
  /** New ids reported this app run — kept through a port reopen, so a replug does not repeat them. */
  private newSeen = new Set<number>()

  constructor(private readonly lookup: NodeLookup) {}

  /** A port open: a different board, or the same one after an outage. Its state starts over. */
  reset(): void {
    this.prev.clear()
    this.pages.clear()
    this.baseline = true
    this.baselineAt = undefined
  }

  /**
   * After one `_NODE_STATUS` / `_NODE_STATUS_END` line was applied to the roster: the roster as it
   * now stands (fault labels filled in), and the line that changed it.
   */
  status(roster: NodeStatus[], identifier: string, raw: string, now: number): LogEventInput[] {
    const out: LogEventInput[] = []
    const isEnd = identifier === NODE_END_MSG
    this.baselineAt ??= now
    // A bridge that never ends its roster reply: the baseline closes once the reply window passes.
    if (this.baseline && !isEnd && now - this.baselineAt > ROSTER_REPLY_MS) {
      out.push(this.endBaseline('', now))
    }
    for (const n of roster) {
      // The bridge's own row (node 0, v3) is this client's link: no events, not in the counts.
      if (n.nodeId === BRIDGE_NODE_ID) continue
      const p = this.prev.get(n.nodeId)
      this.prev.set(n.nodeId, n)
      out.push(...this.diff(p, n, raw, isEnd, now))
    }
    if (isEnd && this.baseline) out.push(this.endBaseline(raw, now))
    return out
  }

  /** One decoded `_NODE_TELEM` frame: PDU rail / status flags raised and cleared. */
  telemetry(t: NodeTelem, raw: string, now: number): LogEventInput[] {
    if (t.kind === 'unknown') return []
    const key = `${t.nodeId}:${t.page}`
    const was = this.pages.get(key) ?? 0
    this.pages.set(key, t.flags)
    if (was === t.flags) return []
    const out: LogEventInput[] = []
    const ev = (bit: number, text: string, severity: EventSeverity, reading?: string): void => {
      const on = (t.flags & bit) !== 0
      if (on === ((was & bit) !== 0)) return
      out.push({
        t: now,
        source: 'node',
        nodeId: t.nodeId,
        name: this.lookup.name(t.nodeId),
        severity: on ? severity : 'info',
        event: `${text} ${on ? 'raised' : 'cleared'}`,
        detail: on ? reading : undefined,
        raw
      })
    }
    if (t.kind === 'rail') {
      const rail = t.page === TELEM_PAGE.PDU_RAIL_12V ? '12V' : '5V'
      for (const [bit, text] of RAIL_FLAGS) {
        ev(bit, `${rail} ${text}`, 'warn', railReading(bit, t))
      }
    } else {
      const temp = t.ntcTempC === null ? undefined : `${t.ntcTempC.toFixed(1)} °C`
      for (const [bit, text, severity] of PDU_STATUS_FLAGS) {
        ev(bit, text, severity, bit & TEMP_FLAGS ? temp : undefined)
      }
    }
    return out
  }

  private endBaseline(raw: string, now: number): LogEventInput {
    this.baseline = false
    let online = 0
    for (const n of this.prev.values()) if (n.present) online++
    return {
      t: now,
      source: 'node',
      name: 'roster',
      severity: 'info',
      event: `${online} node${online === 1 ? '' : 's'} online`,
      raw
    }
  }

  private diff(
    p: NodeStatus | undefined,
    n: NodeStatus,
    raw: string,
    isEnd: boolean,
    now: number
  ): LogEventInput[] {
    const out: LogEventInput[] = []
    const id = n.nodeId
    const ev = (severity: EventSeverity, event: string, detail?: string): void => {
      out.push({
        t: now,
        source: 'node',
        nodeId: id,
        name: this.lookup.name(id),
        severity,
        event,
        detail,
        raw
      })
    }
    const emittedNew = n.present && this.lookup.isNew(id) && !this.newSeen.has(id)
    if (emittedNew) {
      this.newSeen.add(id)
      ev(
        'new',
        'new on the bus',
        this.lookup.inRegistry?.(id) ? 'in NODE_IDS.md' : 'not in registry'
      )
    }
    const wasPresent = p?.present ?? false
    if (!n.present && (p === undefined || wasPresent)) {
      // A live delta is the bridge's heartbeat timeout; a roster end finds a node missing from it.
      ev('error', 'offline', isEnd ? 'missing from roster' : 'no heartbeat')
    } else if (n.present && !wasPresent) {
      // A first sighting the baseline counts in its summary row, or that just made its "new" row,
      // needs no "online" too; nor does an unmapped node not yet announced — it gets one "new on
      // the bus" row once it identifies (#344). A new node seen in an earlier port session does:
      // it has no other row.
      const first = p === undefined
      const unannounced = this.lookup.unmapped(id) && !this.newSeen.has(id)
      if (!first || !(this.baseline || emittedNew || unannounced)) ev('info', 'online')
    }
    return this.flagsFrom(wasPresent ? p : undefined, n, ev, out)
  }

  /** Flags only mean something while the node reports; one coming back reports them afresh. */
  private flagsFrom(
    was: NodeStatus | undefined,
    n: NodeStatus,
    ev: (severity: EventSeverity, event: string, detail?: string) => void,
    out: LogEventInput[]
  ): LogEventInput[] {
    if (!n.present) return out
    // In the Cockpit's order (faults.ts NODE_FLAG_ORDER), so the Log names them as it does.
    for (const f of NODE_FLAGS) {
      const before = was?.[f.key] ?? false
      const on = n[f.key]
      if (f.key === 'degraded' && on && before && was!.faultId !== n.faultId) {
        ev('warn', 'degraded', faultLabel(n))
      } else if (on && !before) {
        const detail =
          f.key === 'degraded' ? faultLabel(n) : f.key === 'epvf' ? `TEC ${n.tec}` : undefined
        ev(f.severity, f.label, detail)
      } else if (!on && before) {
        ev('info', `${f.label} cleared`)
      }
    }
    return out
  }
}
