// Log tab › Events (#64): what the view shows of the session's events (pure, no React).
import { eventText, isProblem, MAX_EVENTS, type EventSource, type LogEvent } from '@shared/events'

export type LogView = 'stream' | 'events'
export type EventSourceFilter = 'all' | EventSource

export interface EventFilter {
  source: EventSourceFilter
  problemsOnly: boolean
  search: string
  /** While paused, the view stays as it was: rows newer than this id are held back. */
  pauseMark?: number
}

/** `Client · SERIAL` for client rows; a node row is its node's name. */
export function eventSourceLabel(e: Pick<LogEvent, 'source' | 'name'>): string {
  return e.source === 'client' ? `Client · ${e.name}` : e.name
}

/** Rows the Events view lists, newest first. Search matches the source or the event. */
export function filterEvents(events: LogEvent[], f: EventFilter): LogEvent[] {
  const q = f.search.trim().toLowerCase()
  return events.filter(
    (e) =>
      (f.pauseMark === undefined || e.id <= f.pauseMark) &&
      (f.source === 'all' || e.source === f.source) &&
      (!f.problemsOnly || isProblem(e)) &&
      (!q || `${eventSourceLabel(e)} ${eventText(e)}`.toLowerCase().includes(q))
  )
}

/**
 * Fold a push (oldest first) into the store's list (newest first), capped like main's. Ids main
 * already handed over are skipped, so a snapshot and a push that overlap never list a row twice.
 */
export function mergeEvents(
  current: LogEvent[],
  incoming: LogEvent[],
  max = MAX_EVENTS
): LogEvent[] {
  const top = current[0]?.id ?? 0
  const fresh = incoming.filter((e) => e.id > top)
  if (fresh.length === 0) return current
  return [...fresh.reverse(), ...current].slice(0, max)
}

/**
 * A renderer (re)load: main's snapshot (oldest first) with whatever pushes beat it here. Either
 * may hold rows the other lacks, so this is a union by id, newest first.
 */
export function restoreEvents(
  current: LogEvent[],
  snapshot: LogEvent[],
  max = MAX_EVENTS
): LogEvent[] {
  const byId = new Map<number, LogEvent>()
  for (const e of [...snapshot, ...current]) byId.set(e.id, e)
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, max)
}

// ── Cockpit › Board events ──────────────────────────────────────────────────

/** One Board events line: `PDU_Right 5V UNDER-V raised · 4.71 V`; the roster summary alone. */
export function boardEventLine(e: Pick<LogEvent, 'nodeId' | 'name' | 'event' | 'detail'>): string {
  return e.nodeId === undefined ? eventText(e) : `${e.name} ${eventText(e)}`
}

/**
 * Whole rows that fit a list `height` px tall, rows `rowHeight` px each — never a half row. Before
 * a row has been measured (0), `max`; at least one, so a cramped box still says something.
 */
export function rowsThatFit(height: number, rowHeight: number, max: number): number {
  if (rowHeight <= 0) return max
  return Math.min(max, Math.max(1, Math.floor(height / rowHeight)))
}

/** `skyhawk-events-….tsv` from a full save path, for the footer's "Saved" note. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
