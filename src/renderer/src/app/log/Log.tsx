import { useEffect, useState } from 'react'
import { fileName } from '@shared/format'
import { StreamView, useDcsStore, type DirFilter } from '../../dcs'
import { EventsView, filterEvents, useEventsStore } from '../../events'
import { useNav, type EventSourceFilter, type LogView } from '../kit'

/** How long the footer says where an export went. */
const SAVED_NOTE_MS = 2600

/** Most rows either view renders; the rest stay in memory and in the export. */
const MAX_SHOWN = 1000

/**
 * The Log tab: the DCS-BIOS stream (dcs) and the session's events (events) under one toolbar; the
 * sub-tab and the source filter are where-the-user-is state (nav).
 */
export function Log() {
  const nav = useNav()
  const dcs = useDcsStore()
  const ev = useEventsStore()
  const toggle = useDcsStore((x) => x.toggle)
  const togglePause = useEventsStore((x) => x.togglePause)
  const clearLog = useDcsStore((x) => x.clearLog)
  const exportLog = useDcsStore((x) => x.exportLog)
  const clearEvents = useEventsStore((x) => x.clearEvents)
  const exportEvents = useEventsStore((x) => x.exportEvents)
  const [saved, setSaved] = useState<string>()

  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(undefined), SAVED_NOTE_MS)
    return () => clearTimeout(t)
  }, [saved])

  const events = nav.logView === 'events'
  const q = dcs.search.trim().toLowerCase()

  let rows = dcs.log
  if (dcs.dirFilter !== 'all') rows = rows.filter((r) => r.dir === dcs.dirFilter)
  if (q) rows = rows.filter((r) => (r.name + ' ' + r.addrHex).toLowerCase().includes(q))

  const evRows = filterEvents(ev.events, {
    source: nav.eventSource,
    problemsOnly: ev.problemsOnly,
    search: dcs.search,
    pauseMark: ev.logPaused ? ev.eventsPauseMark : undefined
  })

  const doExport = async () => {
    const count = events ? ev.events.length : dcs.log.length
    const path = await (events ? exportEvents() : exportLog())
    if (path) setSaved(`✓ Saved ${fileName(path)} · ${count.toLocaleString('en-US')} rows`)
  }

  const viewBtn = (id: LogView, label: string, n: number) => (
    <button
      role="tab"
      aria-selected={nav.logView === id}
      className={`subtab${nav.logView === id ? ' on' : ''}`}
      onClick={() => nav.set({ logView: id })}
    >
      {label} <span className="subtab__n">{n.toLocaleString('en-US')}</span>
    </button>
  )

  const dirBtn = (id: DirFilter, label: string) => (
    <button className={dcs.dirFilter === id ? 'on' : ''} onClick={() => dcs.set({ dirFilter: id })}>
      {label}
    </button>
  )

  const srcBtn = (id: EventSourceFilter, label: string) => (
    <button
      className={nav.eventSource === id ? 'on' : ''}
      onClick={() => nav.set({ eventSource: id })}
    >
      {label}
    </button>
  )

  const total = ev.events.length
  const foot = saved
    ? saved
    : events
      ? `${evRows.length === total ? total : `${evRows.length} of ${total}`} events this session · in memory, cleared on restart`
      : `${rows.length} rows · ${dcs.fps} frames/s`

  return (
    <div className="logview">
      <div className="subtabs" role="tablist" aria-label="Log views">
        {viewBtn('stream', 'Stream', dcs.log.length)}
        {viewBtn('events', 'Events', total)}
      </div>
      <div className={`log${events ? ' log--node' : ''}`} role="tabpanel">
        <div className="log__toolbar">
          <div className="log__search">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#5a6b86"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              value={dcs.search}
              onChange={(e) => dcs.set({ search: e.target.value })}
              placeholder={events ? 'Search source or event…' : 'Search name or address…'}
            />
          </div>
          {events ? (
            <>
              <div className="segmini">
                {srcBtn('all', 'All')}
                {srcBtn('node', 'Nodes')}
                {srcBtn('client', 'Client')}
              </div>
              <button
                className={`toolbtn${ev.problemsOnly ? ' on' : ''}`}
                aria-pressed={ev.problemsOnly}
                onClick={() => ev.set({ problemsOnly: !ev.problemsOnly })}
              >
                Problems only
              </button>
            </>
          ) : (
            <div className="segmini">
              {dirBtn('all', 'All')}
              {dirBtn('in', 'In')}
              {dirBtn('out', 'Out')}
            </div>
          )}
          <div className="log__tools">
            <button
              className={`toolbtn${ev.logPaused ? ' warn' : ''}`}
              onClick={() => togglePause()}
            >
              {ev.logPaused ? '▶ Resume' : '❚❚ Pause'}
            </button>
            <button
              className={`toolbtn${dcs.autoscroll ? ' on' : ''}`}
              onClick={() => toggle('autoscroll')}
            >
              Autoscroll
            </button>
            <button
              className={`toolbtn${dcs.rawMode ? ' on' : ''}`}
              onClick={() => toggle('rawMode')}
            >
              {dcs.rawMode ? 'Raw' : 'Decoded'}
            </button>
            <button
              className="toolbtn"
              title={events ? "Clear this session's events" : 'Clear the stream log'}
              onClick={() => (events ? clearEvents() : clearLog())}
            >
              Clear
            </button>
            <button
              className="toolbtn"
              title={events ? 'Save events to a file' : 'Save the stream log to a file'}
              onClick={() => void doExport()}
            >
              Export
            </button>
          </div>
        </div>

        {events ? (
          <div className="log__grid log__head">
            <span>Time</span>
            <span />
            <span>Source</span>
            <span>{dcs.rawMode ? 'Message (raw)' : 'Event'}</span>
          </div>
        ) : (
          <div className="log__grid log__head">
            <span>Time</span>
            <span>Dir</span>
            <span>{dcs.rawMode ? 'Address' : 'Control'}</span>
            <span className="right">Value</span>
          </div>
        )}

        <div className="log__rows scroll">
          {events ? (
            <EventsView rows={evRows.slice(0, MAX_SHOWN)} rawMode={dcs.rawMode} />
          ) : (
            <StreamView rows={rows.slice(0, MAX_SHOWN)} rawMode={dcs.rawMode} />
          )}
        </div>

        <div className="log__foot">
          <span>{foot}</span>
          <span>{ev.logPaused ? 'PAUSED' : 'LIVE'}</span>
        </div>
      </div>
    </div>
  )
}
