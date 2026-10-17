// Where event-log rows are reported (moved out of DeviceLink, R2.2a): node changes and the
// Gateway's health, handed on to whoever records them. A thin owner for now — Session still hosts
// the EventLog (R2.3 moves it here).
import type { LogEventInput } from '@shared/events'

type Unsubscribe = () => void

export class EventJournal {
  private readonly eventCbs = new Set<(events: LogEventInput[]) => void>()

  /** Rows for the event log (#64): online / offline, flags raised and cleared, new nodes. */
  report(events: LogEventInput[]): void {
    if (events.length) for (const cb of this.eventCbs) cb(events)
  }

  onEvents(cb: (events: LogEventInput[]) => void): Unsubscribe {
    this.eventCbs.add(cb)
    return () => this.eventCbs.delete(cb)
  }
}
