import { useStore, type DirFilter } from '../store'

export function Log() {
  const s = useStore()
  const set = useStore((x) => x.set)
  const toggle = useStore((x) => x.toggle)
  const clearLog = useStore((x) => x.clearLog)
  const exportLog = useStore((x) => x.exportLog)

  let rows = s.log
  if (s.dirFilter !== 'all') rows = rows.filter((r) => r.dir === s.dirFilter)
  if (s.search.trim()) {
    const q = s.search.trim().toLowerCase()
    rows = rows.filter((r) => (r.name + ' ' + r.addrHex).toLowerCase().includes(q))
  }
  const view = rows.slice(0, 1000)

  const dirBtn = (id: DirFilter, label: string) => (
    <button className={s.dirFilter === id ? 'on' : ''} onClick={() => set({ dirFilter: id })}>
      {label}
    </button>
  )

  return (
    <div className="log">
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
            placeholder="Search name or address…"
          />
        </div>
        <div className="segmini">
          {dirBtn('all', 'All')}
          {dirBtn('in', 'In')}
          {dirBtn('out', 'Out')}
        </div>
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
          <button className={`toolbtn${s.rawMode ? ' on' : ''}`} onClick={() => toggle('rawMode')}>
            {s.rawMode ? 'Raw' : 'Decoded'}
          </button>
          <button className="toolbtn" onClick={() => clearLog()}>
            Clear
          </button>
          <button className="toolbtn" onClick={() => exportLog()}>
            Export
          </button>
        </div>
      </div>

      <div className="log__grid log__head">
        <span>Time</span>
        <span>Dir</span>
        <span>{s.rawMode ? 'Address' : 'Control'}</span>
        <span className="right">Value</span>
      </div>

      <div className="log__rows scroll">
        {view.map((r) => (
          <div className="log__grid log__row" key={r.id}>
            <span className="log__time">{r.time}</span>
            <span
              className="log__dir"
              style={{
                color:
                  r.dir === 'sys' ? 'var(--red)' : r.dir === 'in' ? 'var(--green)' : 'var(--blue)'
              }}
            >
              {r.dir === 'sys' ? '! SYS' : r.dir === 'in' ? 'IN ▸' : '◂ OUT'}
            </span>
            <span
              className="log__name"
              style={r.dir === 'sys' ? { color: 'var(--red)' } : undefined}
            >
              {r.dir === 'sys' ? r.name : s.rawMode ? r.addrHex : r.name}
            </span>
            <span
              className="log__val"
              style={{
                color:
                  r.dir === 'sys'
                    ? 'var(--red)'
                    : s.rawMode
                      ? 'var(--muted-4)'
                      : r.dir === 'out'
                        ? 'var(--blue)'
                        : '#cdd6e6'
              }}
            >
              {r.dir === 'sys' ? String(r.value) : s.rawMode ? r.raw : String(r.value)}
            </span>
          </div>
        ))}
      </div>

      <div className="log__foot">
        <span>
          {rows.length} rows · {s.fps} frames/s
        </span>
        <span>{s.logPaused ? 'PAUSED' : 'LIVE'}</span>
      </div>
    </div>
  )
}
