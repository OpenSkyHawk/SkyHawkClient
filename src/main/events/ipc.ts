// events' intents: the event log (#64) read, cleared and exported. app/ipc.ts registers them.
import { writeFileSync } from 'node:fs'
import type { IpcRegistrar } from '@shared/app'
import { EVENTS_CTRL } from '@shared/events'
import type { EventJournal } from './event-journal'

/** The dialog events' export opens (app/dialogs.ts). Resolves to the picked path, if any. */
export interface EventsDialogs {
  saveEvents(): Promise<string | undefined>
}

export interface EventsIpcDeps {
  journal: EventJournal
  dialogs: EventsDialogs
}

export function registerEventsIpc(ipc: IpcRegistrar, deps: EventsIpcDeps): void {
  const { journal, dialogs } = deps
  ipc.handle(EVENTS_CTRL.eventsGet, () => journal.snapshot())
  ipc.handle(EVENTS_CTRL.eventsClear, () => journal.clear())
  ipc.handle(EVENTS_CTRL.eventsExport, async () => {
    const text = journal.exportTsv() // the rows as they are when asked
    const filePath = await dialogs.saveEvents()
    if (!filePath) return {}
    writeFileSync(filePath, text)
    return { path: filePath }
  })
}
