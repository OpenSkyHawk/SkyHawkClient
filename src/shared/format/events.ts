// Event-log text. Only pure formatting lives here: the severity tables and `isProblem` are keyed
// by the events contract's EventSeverity, which this leaf cannot import, so they live in
// shared/events/legacy-rules.ts.

/** `event · detail`, as the Events view and the Cockpit box print it. */
export function eventText(e: { event: string; detail?: string }): string {
  return e.detail ? `${e.event} · ${e.detail}` : e.event
}
