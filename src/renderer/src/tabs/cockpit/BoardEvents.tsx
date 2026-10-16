import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fmtTime, useStore } from '../../store'
import { boardEventLine, rowsThatFit } from '../../log-view'

/** Most rows the box renders before it has measured how many fit. */
const MAX_ROWS = 30

/**
 * Cockpit › Board events (#64): the session's newest node events, one line each, as many whole
 * rows as the box has room for. The full list is Log › Events, filtered to Nodes.
 */
export function BoardEvents() {
  const events = useStore((s) => s.events)
  const showEvents = useStore((s) => s.showEvents)
  const rows = useMemo(() => events.filter((e) => e.source === 'node'), [events])
  const list = useRef<HTMLUListElement>(null)
  const [fit, setFit] = useState(MAX_ROWS)
  const any = rows.length > 0

  useLayoutEffect(() => {
    const ul = list.current
    if (!ul) return
    // The list fills what the card leaves it, whatever it holds, so its height is the room.
    const measure = () => {
      const row = ul.querySelector('li')?.getBoundingClientRect().height ?? 0
      setFit(rowsThatFit(ul.clientHeight, row, MAX_ROWS))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(ul)
    return () => ro.disconnect()
  }, [any])

  return (
    <div className="card field">
      <div className="panel-h">
        <span className="section-h">Board events</span>
        <span className="meta">newest</span>
      </div>
      {any ? (
        <ul className="evt evt--one" ref={list}>
          {rows.slice(0, fit).map((e) => {
            const line = boardEventLine(e)
            return (
              <li key={e.id}>
                <time>{fmtTime(e.t).slice(0, 8)}</time>
                <span title={line}>{line}</span>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="hint">No board events yet this session.</div>
      )}
      <div className="more">
        <span>
          {rows.length} event{rows.length === 1 ? '' : 's'} this session
        </span>
        <button className="browse" onClick={() => showEvents('node')}>
          View all in Log →
        </button>
      </div>
    </div>
  )
}
