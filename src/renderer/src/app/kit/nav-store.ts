// Where the user is (R3.4b): the tab, the Log tab's sub-tab and source filter, and the targets one
// tab hands another (the Cockpit's side panel and Adopt dialog, the title-bar Device popover). View
// state only; nothing here comes from main. A leaf (app/kit), so every topic may read and set it.
import { create } from 'zustand'
import type { EventSource } from '@shared/events'

export type TabId = 'overview' | 'connection' | 'cockpit' | 'log' | 'serial' | 'hid' | 'settings'

export type LogView = 'stream' | 'events'
export type EventSourceFilter = 'all' | EventSource

export interface NavState {
  tab: TabId
  /** Log tab sub-tab (#64): the DCS-BIOS stream, or the event log. */
  logView: LogView
  eventSource: EventSourceFilter
  /**
   * NODE_ID the Cockpit opens when its tab next mounts (#66): its side panel, or the Adopt dialog on
   * it — the Cockpit routes it by main's pushed `opens` (D6), never by its own reading.
   */
  cockpitOpen?: number
  /** The Cockpit's Adopt dialog opens when the Cockpit tab next mounts (#77). */
  cockpitAdopt?: boolean
  /** The title-bar Device popover is open — also opened by Overview's Details and Attention's cog (#94). */
  devicePopOpen: boolean

  set: (patch: Partial<NavState>) => void
  /** Log › Events, with a source filter — the Cockpit's "View all in Log →". */
  showEvents: (source: EventSourceFilter) => void
  /** The Cockpit tab with this node open, as main routes it — Connection's "›". */
  openInCockpit: (nodeId: number) => void
  /** The Cockpit tab with the Adopt dialog open — the Overview's new-devices notice. */
  openAdopt: () => void
}

export const useNav = create<NavState>((set) => ({
  tab: 'overview',
  logView: 'stream',
  eventSource: 'all',
  devicePopOpen: false,

  set: (patch) => set(patch),

  showEvents: (source) => set({ tab: 'log', logView: 'events', eventSource: source }),

  openInCockpit: (nodeId) => set({ tab: 'cockpit', cockpitOpen: nodeId }),
  openAdopt: () => set({ tab: 'cockpit', cockpitAdopt: true })
}))
