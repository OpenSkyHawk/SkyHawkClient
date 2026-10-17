import type { EventSeverity, LogEvent } from '@shared/events'
import { eventText, fmtTime } from '@shared/format'
import { eventSourceLabel, SEVERITY_GLYPH } from './events-view'

const SEVERITY_COLOR: Record<EventSeverity, string> = {
  error: 'var(--red)',
  warn: 'var(--gold)',
  new: 'var(--blue)',
  info: 'var(--green)'
}

const SEVERITY_NAME: Record<EventSeverity, string> = {
  error: 'Offline / error',
  warn: 'Warning',
  new: 'New',
  info: 'Cleared / info'
}

/**
 * Log › Events (#64): the rows the Log tab picked (filtered, newest first, capped), one line each.
 * `rawMode` shows each event's raw message.
 */
export function EventsView({ rows, rawMode }: { rows: LogEvent[]; rawMode: boolean }) {
  return (
    <>
      {rows.map((e) => (
        <div className="log__grid log__row" key={e.id}>
          <span className="log__time">{fmtTime(e.t)}</span>
          <span
            className="log__dir"
            style={{ color: SEVERITY_COLOR[e.severity] }}
            title={SEVERITY_NAME[e.severity]}
            aria-label={SEVERITY_NAME[e.severity]}
          >
            {SEVERITY_GLYPH[e.severity]}
          </span>
          <span className="log__name">{eventSourceLabel(e)}</span>
          <span
            className="log__val"
            style={{
              color:
                rawMode || e.severity === 'info' ? 'var(--muted-4)' : SEVERITY_COLOR[e.severity]
            }}
          >
            {rawMode ? e.raw : eventText(e)}
          </span>
        </div>
      ))}
    </>
  )
}
