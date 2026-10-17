// The event log's owner (#64): hosts the app run's EventLog (its own service since R2.3b) and
// takes the rows the other owners report — node changes and the Gateway's health (NodeHub), the
// relay's rows (DcsRelay), client errors, and the Gateway link's state rows. The rows themselves
// are made where they happen (nodes, gateway/link-events.ts, dcs/relay-events.ts); this only
// records them, dedupes the repeats, and pushes what is new on the stream log's flush.
import type { Emit } from '@shared/app'
import type { EventsPushChannels, LogEvent, LogEventInput } from '@shared/events'
import type { DeviceState } from '@shared/gateway'
import { clientErrorEvent, EventLog, eventsToTsv } from './event-log'

/** Where client errors also go (app's debug log). */
export type JournalLog = (tag: string, data?: unknown) => void

export class EventJournal {
  /** The event log (#64): node and client events, this app run only. */
  private readonly events = new EventLog()
  /** Last device state the event log reported (scanning never is). */
  private lastDevice?: DeviceState
  /** Last message per error tag: a retry loop repeating one failure is one row, not one per try. */
  private lastErr = new Map<string, string>()

  constructor(
    private readonly emit: Emit<keyof EventsPushChannels>,
    private readonly log: JournalLog
  ) {}

  /** Rows for the event log (#64): online / offline, flags raised and cleared, new nodes. */
  report(events: LogEventInput[]): void {
    if (events.length) this.add(events)
  }

  /** Rows, as they are. */
  add(events: LogEventInput[]): void {
    this.events.add(events)
  }

  /** Push a client diagnostic into the event log + the debug log file. */
  error(tag: string, msg: string): void {
    this.log(`error.${tag}`, msg) // always reaches debug.log when debug mode is on
    if (this.lastErr.get(tag) === msg) return // dedupe the event log only
    this.lastErr.set(tag, msg)
    this.events.add([clientErrorEvent(tag, msg, Date.now())])
  }

  /** Forget the tag's last error, so the next one is news. */
  forget(tag: string): void {
    this.lastErr.delete(tag)
  }

  /**
   * A Gateway link state: `row` makes its row, if any, from the last state reported. One row per
   * state; scanning is never remembered, so a retry loop adds nothing after its first row.
   */
  linkState(
    state: DeviceState,
    row: (last: DeviceState | undefined) => LogEventInput | null
  ): void {
    const e = row(this.lastDevice)
    if (e) this.events.add([e])
    if (state !== 'scanning') this.lastDevice = state
  }

  /** The rows added since the last flush, pushed as `events:batch`. */
  flush(): void {
    const events = this.events.take()
    if (events.length) this.emit('events:batch', events)
  }

  /** events:get. */
  snapshot(): LogEvent[] {
    return this.events.snapshot()
  }

  /** events:clear. */
  clear(): void {
    this.events.clear()
  }

  /** events:export: every row as it is now, as TSV. */
  exportTsv(): string {
    return eventsToTsv(this.events.snapshot())
  }
}
