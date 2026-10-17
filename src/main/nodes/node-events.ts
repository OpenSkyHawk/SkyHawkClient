// Node events (#64): the change events the event log gets from the boards' own reports
// (`_NODE_STATUS`, `_NODE_TELEM`). Pure, no Node/Electron deps. The client never applies a
// threshold, so every alert here is a flag a board raised itself.
//
// The log is the physical bus (D8 / S5): every board on it is logged. A board outside your cockpit
// (never added or adopted, or forgotten) gets its rows at info, labelled `not in your cockpit`, so
// only your cockpit's problems read as warnings and errors. Whether a board is new is the model's
// one answer (node-model.ts newState), never worked out again here.
import type { EventSeverity, LogEventInput } from '@shared/events'
import type { NodeModelEntry, NodeStatus, NodeTelem } from '@shared/nodes'
import { faultLabel } from '../events'
import { NODE_FLAGS, PDU_STATUS_FLAGS, RAIL_FLAGS, railReading, TEMP_FLAGS } from './faults'
import { newReason, newState, onlineByPages, strayKind } from './node-model'
import { BRIDGE_NODE_ID, NODE_END_MSG, ROSTER_REPLY_MS } from './node-status-wire'
import { TELEM_PAGE } from './node-telem'

/** The label on a row about a board outside your cockpit (D8 / S5). */
export const OUTSIDE_COCKPIT = 'not in your cockpit'

/** The row a board outside your cockpit gets once, when newState first has something to say. */
const NEW_ON_BUS = 'new on the bus'

/** What the node mapping and the model say about an id, as the tracker needs it. */
export interface NodeLookup {
  /** Effective name; `Node <id>` when the id has none. */
  name(nodeId: number): string
  /** Not in your cockpit (never added or adopted, or forgotten), whatever it has identified as. */
  outside(nodeId: number): boolean
  /**
   * Its node-model entry, as the model stands with the line just applied (node-model.ts
   * buildNodeModel); undefined when the model leaves it out.
   */
  entry(nodeId: number): NodeModelEntry | undefined
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
  /**
   * Boards outside your cockpit announced this app run ("new on the bus"), as what: news (it can be
   * adopted) or a stray. Kept through a port reopen, so a replug does not repeat them; dropped once
   * the board is in your cockpit (cockpitChanged), so one you forget is new again when it returns.
   */
  private newSeen = new Map<number, 'news' | 'stray'>()
  /** Boards online by their PDU pages alone (no present roster row), as last logged. */
  private byPages = new Set<number>()
  /** Boards that were online by their pages at some point since the port opened. */
  private pagesEver = new Set<number>()

  constructor(private readonly lookup: NodeLookup) {}

  /** A port open: a different board, or the same one after an outage. Its state starts over. */
  reset(): void {
    this.prev.clear()
    this.pages.clear()
    this.byPages.clear()
    this.pagesEver.clear()
    this.baseline = true
    this.baselineAt = undefined
  }

  /**
   * The node mapping changed (an add, an adopt, Forget, Reset…, an import): a board now in your
   * cockpit has no "seen new" record, so if it is forgotten later and plugged back in, its "new on
   * the bus" row comes again (C4).
   */
  cockpitChanged(): void {
    for (const id of [...this.newSeen.keys()]) {
      if (!this.lookup.outside(id)) this.newSeen.delete(id)
    }
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

  /**
   * After each model push: the boards online by their PDU pages alone (node-model.ts
   * onlineByPages) get the rows a roster-seen board gets — online when they come online, offline
   * when their pages stop and nothing else says they are on the bus.
   */
  pagesOnline(entries: NodeModelEntry[], now: number): LogEventInput[] {
    const out: LogEventInput[] = []
    const online = new Set(entries.filter(onlineByPages).map((e) => e.nodeId))
    for (const id of online) {
      if (this.byPages.has(id)) continue
      this.byPages.add(id)
      // A first sighting the baseline counts, or a board outside your cockpit — its "new on the
      // bus" row says it came — needs no "online" row, as in diff.
      const first = !this.pagesEver.has(id) && this.prev.get(id) === undefined
      this.pagesEver.add(id)
      if (!first || !(this.baseline || this.lookup.outside(id))) {
        out.push(this.row(id, 'info', 'online', undefined, '', now))
      }
    }
    for (const id of [...this.byPages]) {
      if (online.has(id)) continue
      this.byPages.delete(id)
      if (this.prev.get(id)?.present) continue // the roster lists it now
      out.push(this.row(id, 'error', 'offline', 'no telemetry', '', now))
    }
    return out
  }

  /** One decoded `_NODE_TELEM` frame: PDU rail / status flags raised and cleared. */
  telemetry(t: NodeTelem, raw: string, now: number): LogEventInput[] {
    if (t.kind === 'unknown') return []
    // Its pages may be what identifies it (a PDU): its "new on the bus" row comes now (C4).
    const out: LogEventInput[] = []
    const announced = this.announce(t.nodeId, raw, now)
    if (announced) out.push(announced)
    const key = `${t.nodeId}:${t.page}`
    const was = this.pages.get(key) ?? 0
    this.pages.set(key, t.flags)
    if (was === t.flags) return out
    const ev = (bit: number, text: string, severity: EventSeverity, reading?: string): void => {
      const on = (t.flags & bit) !== 0
      if (on === ((was & bit) !== 0)) return
      out.push(
        this.row(
          t.nodeId,
          on ? severity : 'info',
          `${text} ${on ? 'raised' : 'cleared'}`,
          on ? reading : undefined,
          raw,
          now
        )
      )
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
    const on = [...this.prev.values()].filter((n) => n.present).map((n) => n.nodeId)
    for (const id of this.byPages) if (!this.prev.get(id)?.present) on.push(id)
    const outside = on.filter((id) => this.lookup.outside(id)).length
    const row: LogEventInput = {
      t: now,
      source: 'node',
      name: 'roster',
      severity: 'info',
      event: `${on.length} node${on.length === 1 ? '' : 's'} online`,
      raw
    }
    // The bus as it is, every board counted; how many of them are not yours, said (D8 / S5).
    if (outside) row.detail = `${outside} ${OUTSIDE_COCKPIT}`
    return row
  }

  /**
   * One row about a board. A board outside your cockpit is on the bus but not yours: its rows are
   * info, labelled (D8 / S5) — except its "new on the bus" row, which says so itself.
   */
  private row(
    id: number,
    severity: EventSeverity,
    event: string,
    detail: string | undefined,
    raw: string,
    now: number
  ): LogEventInput {
    const outside = event !== NEW_ON_BUS && this.lookup.outside(id)
    return {
      t: now,
      source: 'node',
      nodeId: id,
      name: this.lookup.name(id),
      severity: outside ? 'info' : severity,
      event,
      detail: outside ? [detail, OUTSIDE_COCKPIT].filter(Boolean).join(' · ') : detail,
      raw
    }
  }

  /**
   * A board outside your cockpit, on the bus now: its one "new on the bus" row, once newState
   * (node-model.ts, the rule every tab reads) has something to say — news, where it comes from
   * (newReason); or a stray, what it is and that it can't be adopted. Still identifying: nothing
   * yet. A stray that later identifies as something adoptable is news then.
   */
  private announce(id: number, raw: string, now: number): LogEventInput | undefined {
    if (!this.lookup.outside(id) || this.newSeen.get(id) === 'news') return undefined
    const e = this.lookup.entry(id)
    // A line just arrived over the link, so the link is up.
    const s = e && newState(e, now, true)
    if (s?.state === 'news') {
      this.newSeen.set(id, 'news')
      return this.row(id, 'new', NEW_ON_BUS, newReason(e!), raw, now)
    }
    if (s?.state === 'stray' && !this.newSeen.has(id)) {
      this.newSeen.set(id, 'stray')
      return this.row(id, 'info', NEW_ON_BUS, `${strayKind(e!)} · can’t be adopted`, raw, now)
    }
    return undefined
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
      out.push(this.row(id, severity, event, detail, raw, now))
    }
    const announced = n.present ? this.announce(id, raw, now) : undefined
    if (announced) out.push(announced)
    const wasPresent = p?.present ?? false
    if (!n.present && (p === undefined || wasPresent)) {
      // A live delta is the bridge's heartbeat timeout; a roster end finds a node missing from it.
      this.byPages.delete(id)
      ev('error', 'offline', isEnd ? 'missing from roster' : 'no heartbeat')
    } else if (n.present && !wasPresent) {
      // A first sighting the baseline counts in its summary row, or that just made its "new" row,
      // needs no "online" too; nor does a board outside your cockpit not yet announced — it gets
      // one "new on the bus" row once newState says what it is (#344). A new node seen in an
      // earlier port session does: it has no other row. Nor does one already online by its pages.
      const first = p === undefined
      const unannounced = this.lookup.outside(id) && !this.newSeen.has(id)
      const byPages = this.byPages.delete(id)
      if (!byPages && (!first || !(this.baseline || announced || unannounced))) ev('info', 'online')
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
      // One row per episode: raised, then cleared — a fault id that changes while degraded is the
      // same episode (D8), shown on the board's panel.
      if (on && !before) {
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
