// Events topic contract (arch-phase0-v2 §2.3): the session event log (#64). Imported by main,
// preload and the renderer.

export type EventSource = 'node' | 'client'

/** error ✕ (offline / failure), warn ! (a raised flag), new + (new on the bus), info ● (cleared / up). */
export type EventSeverity = 'error' | 'warn' | 'new' | 'info'

export interface LogEventInput {
  t: number
  source: EventSource
  /** Node events about one node; absent for the roster summary and client events. */
  nodeId?: number
  /** Node: its effective name. Client: `SERIAL`, `DCS`, `Gateway` or `Relay`. */
  name: string
  severity: EventSeverity
  /** What happened, e.g. `5V UNDER-V raised`, `offline`, `connected`. */
  event: string
  /** The reading or reason that goes with it, e.g. `4.71 V`, `no heartbeat`. */
  detail?: string
  /** The source line: the `_NODE_STATUS` / `_NODE_TELEM` frame, or the original client message. */
  raw: string
}

export interface LogEvent extends LogEventInput {
  /** Increasing for the whole app run; never reused, not even after Clear. */
  id: number
}

/** Oldest rows go first once the session holds this many. */
export const MAX_EVENTS = 5000

/** This topic's main -> renderer pushes; shared/app assembles them into `PushChannels`. */
export interface EventsPushChannels {
  /** New event-log rows (#64), oldest first. */
  'events:batch': LogEvent[]
}

/** Push channel names (main -> renderer). */
export const EVENTS_PUSH = {
  eventsBatch: 'events:batch'
} as const

/** Intent channel names (renderer -> main, invoke/response). */
export const EVENTS_CTRL = {
  eventsGet: 'events:get',
  eventsClear: 'events:clear',
  eventsExport: 'events:export'
} as const
