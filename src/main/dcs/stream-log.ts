// The Log tab's stream rows: panel commands from the device and the rows the decoder names from
// the export, batched to the renderer on a 33 ms flush. The same flush pushes the event log's new
// rows first (its `events:batch`).
import type { StreamRow } from '@shared/dcs'
import type { Emit } from '@shared/app'
import type { DeviceLine } from '../gateway'
import type { Stats } from './stream-stats'

/** The event log, as this flush drives it (EventJournal). */
export interface StreamLogEvents {
  /** Push the event log's new rows (`events:batch`). */
  flush(): void
}

const LOG_FLUSH_MS = 33
const MAX_BATCH = 250

export class StreamLog {
  private logBuf: StreamRow[] = []
  private logTimer?: ReturnType<typeof setInterval>

  constructor(
    private readonly emit: Emit,
    private readonly stats: Stats,
    /** The event log whose new rows ride this flush. */
    private readonly events: StreamLogEvents
  ) {}

  /** Start the flush. False when it is already running. */
  open(): boolean {
    if (this.logTimer) return false
    this.logTimer = setInterval(() => this.flushLog(), LOG_FLUSH_MS)
    return true
  }

  /** Stop the flush. */
  close(): void {
    if (this.logTimer) clearInterval(this.logTimer)
    this.logTimer = undefined
  }

  /** A line from the device: panel commands are logged and counted. */
  onLine(l: DeviceLine): void {
    if (l.kind !== 'command') return
    // Logged relaying or not: watching panel commands with no DCS is how a panel gets tested.
    this.stats.command(l.line)
    this.logBuf.push({ t: l.t, dir: 'out', address: 0, name: l.identifier, value: l.arg })
  }

  /** Rows the decoder named from one export write. */
  rows(rows: StreamRow[]): void {
    for (const r of rows) this.logBuf.push(r)
  }

  flushLog(): void {
    this.events.flush()
    if (this.logBuf.length === 0) return
    const batch = this.logBuf.splice(0, MAX_BATCH)
    this.emit('log:batch', batch)
  }
}
