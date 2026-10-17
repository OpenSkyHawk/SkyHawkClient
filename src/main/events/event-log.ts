// Event log (#64): what the client observed, node and client, as a session list (pure, no
// Node/Electron deps). In memory only — never written to the debug log — and cleared on Clear or
// restart.
import { MAX_EVENTS, type LogEvent, type LogEventInput } from '@shared/events'
import { fmtDateTime } from '@shared/format'

// ── client events ───────────────────────────────────────────────────────────

/**
 * A client diagnostic — the `SERIAL` / `DCS` errors the Stream used to show as `! SYS`. A warn row
 * (a problem the client recovered from, nothing lost) is labelled as one: its event reads
 * `warning` and its raw text `<tag> Warning: …`, so nothing on it says "error".
 */
export function clientErrorEvent(
  tag: string,
  message: string,
  now: number,
  severity: 'error' | 'warn' = 'error'
): LogEventInput {
  const warn = severity === 'warn'
  return {
    t: now,
    source: 'client',
    name: tag,
    severity,
    event: warn
      ? 'warning'
      : tag === 'SERIAL'
        ? 'serial port error'
        : tag === 'DCS'
          ? 'link error'
          : 'error',
    detail: message,
    raw: `${tag} ${warn ? 'Warning' : 'Error'}: ${message}`
  }
}

// ── the session list ────────────────────────────────────────────────────────

/** The session's events, oldest first, plus what has not been pushed to the renderer yet. */
export class EventLog {
  private rows: LogEvent[] = []
  private pending: LogEvent[] = []
  private nextId = 1

  constructor(private readonly max = MAX_EVENTS) {}

  add(inputs: LogEventInput[]): void {
    for (const input of inputs) {
      const e = { ...input, id: this.nextId++ }
      this.rows.push(e)
      this.pending.push(e)
    }
    if (this.rows.length > this.max) this.rows.splice(0, this.rows.length - this.max)
    if (this.pending.length > this.max) this.pending.splice(0, this.pending.length - this.max)
  }

  /** Rows added since the last call, oldest first. */
  take(): LogEvent[] {
    const p = this.pending
    this.pending = []
    return p
  }

  snapshot(): LogEvent[] {
    return [...this.rows]
  }

  clear(): void {
    this.rows = []
    this.pending = []
  }
}

// ── export ──────────────────────────────────────────────────────────────────

/** A tab or line break inside a field would shift every column after it. */
const cell = (s: string | number | undefined): string =>
  s === undefined ? '' : String(s).replace(/[\t\r\n]+/g, ' ')

export const EVENTS_TSV_HEADER = 'date_time\tsource\tnode_id\tname\tseverity\tevent\tdetail\traw'

/** Every row, oldest first, whatever the view filters — like the stream export. */
export function eventsToTsv(rows: LogEvent[]): string {
  const body = [...rows]
    .sort((a, b) => a.id - b.id)
    .map((e) =>
      [fmtDateTime(e.t), e.source, e.nodeId, e.name, e.severity, e.event, e.detail, e.raw]
        .map(cell)
        .join('\t')
    )
  return [EVENTS_TSV_HEADER, ...body].join('\n') + '\n'
}
