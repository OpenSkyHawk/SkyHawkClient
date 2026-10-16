import { useEffect, useState } from 'react'
import { eventText, SEVERITY_GLYPH, type EventSeverity } from '@shared/events'
import { fmtTime, useStore, type DirFilter } from '../store'
import {
  eventSourceLabel,
  fileName,
  filterEvents,
  type EventSourceFilter,
  type LogView
} from '../log-view'

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

/** How long the footer says where an export went. */
const SAVED_NOTE_MS = 2600

/** Most rows either view renders; the rest stay in memory and in the export. */
const MAX_SHOWN = 1000

export function Log() {
  const s = useStore()
  const set = useStore((x) => x.set)
  const toggle = useStore((x) => x.toggle)
  const clearLog = useStore((x) => x.clearLog)
  const exportLog = useStore((x) => x.exportLog)
  const clearEvents = useStore((x) => x.clearEvents)
  const exportEvents = useStore((x) => x.exportEvents)
  const [saved, setSaved] = useState<string>()

  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(undefined), SAVED_NOTE_MS)
    return () => clearTimeout(t)
  }, [saved])

  const events = s.logView === 'events'
  const q = s.search.trim().toLowerCase()

  let rows = s.log
  if (s.dirFilter !== 'all') rows = rows.filter((r) => r.dir === s.dirFilter)
  if (q) rows = rows.filter((r) => (r.name + ' ' + r.addrHex).toLowerCase().includes(q))

  const evRows = filterEvents(s.events, {
    source: s.eventSource,
    problemsOnly: s.problemsOnly,
    search: s.search,
    pauseMark: s.logPaused ? s.eventsPauseMark : undefined
  })

  const doExport = async () => {
    const count = events ? s.events.length : s.log.length
    const path = await (events ? exportEvents() : exportLog())
    if (path) setSaved(`✓ Saved ${fileName(path)} · ${count.toLocaleString('en-US')} rows`)
  }

  const viewBtn = (id: LogView, label: string, n: number) => (
    <button
      role="tab"
      aria-selected={s.logView === id}
      className={`subtab${s.logView === id ? ' on' : ''}`}
      onClick={() => set({ logView: id })}
    >
      {label} <span className="subtab__n">{n.toLocaleString('en-US')}</span>
    </button>
  )

  const dirBtn = (id: DirFilter, label: string) => (
    <button className={s.dirFilter === id ? 'on' : ''} onClick={() => set({ dirFilter: id })}>
      {label}
    </button>
  )

  const srcBtn = (id: EventSourceFilter, label: string) => (
    <button className={s.eventSource === id ? 'on' : ''} onClick={() => set({ eventSource: id })}>
      {label}
    </button>
  )

  const total = s.events.length
  const foot = saved
    ? saved
    : events
      ? `${evRows.length === total ? total : `${evRows.length} of ${total}`} events this session · in memory, cleared on restart`
      : `${rows.length} rows · ${s.fps} frames/s`

  return (
    <div className="logview">
      <div className="subtabs" role="tablist" aria-label="Log views">
        {viewBtn('stream', 'Stream', s.log.length)}
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
              value={s.search}
              onChange={(e) => set({ search: e.target.value })}
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
                className={`toolbtn${s.problemsOnly ? ' on' : ''}`}
                aria-pressed={s.problemsOnly}
                onClick={() => set({ problemsOnly: !s.problemsOnly })}
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
              className={`toolbtn${s.logPaused ? ' warn' : ''}`}
              onClick={() => toggle('logPaused')}
            >
              {s.logPaused ? '▶ Resume' : '❚❚ Pause'}
            </button>
            <button
              className={`toolbtn${s.autoscroll ? ' on' : ''}`}
              onClick={() => toggle('autoscroll')}
            >
              Autoscroll
            </button>
            <button
              className={`toolbtn${s.rawMode ? ' on' : ''}`}
              onClick={() => toggle('rawMode')}
            >
              {s.rawMode ? 'Raw' : 'Decoded'}
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
            <span>{s.rawMode ? 'Message (raw)' : 'Event'}</span>
          </div>
        ) : (
          <div className="log__grid log__head">
            <span>Time</span>
            <span>Dir</span>
            <span>{s.rawMode ? 'Address' : 'Control'}</span>
            <span className="right">Value</span>
          </div>
        )}

        <div className="log__rows scroll">
          {events
            ? evRows.slice(0, MAX_SHOWN).map((e) => (
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
                        s.rawMode || e.severity === 'info'
                          ? 'var(--muted-4)'
                          : SEVERITY_COLOR[e.severity]
                    }}
                  >
                    {s.rawMode ? e.raw : eventText(e)}
                  </span>
                </div>
              ))
            : rows.slice(0, MAX_SHOWN).map((r) => (
                <div className="log__grid log__row" key={r.id}>
                  <span className="log__time">{r.time}</span>
                  <span
                    className="log__dir"
                    style={{ color: r.dir === 'in' ? 'var(--green)' : 'var(--blue)' }}
                  >
                    {r.dir === 'in' ? 'IN ▸' : '◂ OUT'}
                  </span>
                  <span className="log__name">{s.rawMode ? r.addrHex : r.name}</span>
                  <span
                    className="log__val"
                    style={{
                      color: s.rawMode
                        ? 'var(--muted-4)'
                        : r.dir === 'out'
                          ? 'var(--blue)'
                          : '#cdd6e6'
                    }}
                  >
                    {s.rawMode ? r.raw : String(r.value)}
                  </span>
                </div>
              ))}
        </div>

        <div className="log__foot">
          <span>{foot}</span>
          <span>{s.logPaused ? 'PAUSED' : 'LIVE'}</span>
        </div>
      </div>
    </div>
  )
}
