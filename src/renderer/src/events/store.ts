// The session's events as main pushes them, and the Log tab's pause (R3.4b: the events slice of
// the old single store, cut verbatim). The pause lives here because it sets the Events view's
// pause mark in the same update and Clear reads it; the stream's `log:batch` reads it from here
// (dcs → events). The IPC adapter binds the intents and delivers the pushes.
import { create } from 'zustand'
import type { SkyhawkApi } from '@shared/app'
import type { LogEvent } from '@shared/events'
import { mergeEvents, restoreEvents } from './events-view'

export interface EventsState {
  /** The session's events (#64), newest first. Main holds the same list; Clear empties both. */
  events: LogEvent[]
  /** Set while paused: the newest event id the Events view still shows. */
  eventsPauseMark?: number
  /** The Log tab's Pause: holds the stream and the Events view (events keep being recorded). */
  logPaused: boolean
  problemsOnly: boolean

  set: (patch: Partial<EventsState>) => void
  /** The Log tab's Pause / Resume. */
  togglePause: () => void
  clearEvents: () => void
  exportEvents: () => Promise<string | undefined>
}

/** Main, as the IPC adapter hands it over; nothing until it binds. */
let api: () => SkyhawkApi | undefined = () => undefined

/** The IPC adapter's binding: every intent reads `window.skyhawk` through it, at call time. */
export function bindEvents(skyhawk: () => SkyhawkApi | undefined): void {
  api = skyhawk
}

export const useEventsStore = create<EventsState>((set, get) => ({
  logPaused: false,
  problemsOnly: false,

  events: [],

  set: (patch) => set(patch),
  togglePause: () =>
    set((s) => {
      const on = !s.logPaused
      // Pausing holds the Events view where it is; events keep being recorded meanwhile.
      return { logPaused: on, eventsPauseMark: on ? (s.events[0]?.id ?? 0) : undefined }
    }),

  clearEvents: () => {
    set({ events: [], eventsPauseMark: get().logPaused ? 0 : undefined })
    void api()?.clearEvents()
  },

  exportEvents: async () => {
    if (get().events.length === 0) return undefined
    return (await api()?.exportEvents())?.path
  }
}))

/** What main sends this slice; the IPC adapter calls each as its push or pull lands. */
export const eventsFromMain = {
  /** `events:get`: events live in main for the whole app run; a reloaded renderer picks the list back up. */
  restore: (rows: LogEvent[]): void =>
    useEventsStore.setState({ events: restoreEvents(useEventsStore.getState().events, rows) }),

  /** `events:batch`. */
  batch: (rows: LogEvent[]): void =>
    useEventsStore.setState({ events: mergeEvents(useEventsStore.getState().events, rows) })
}
