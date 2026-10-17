import type { LogRow } from './stream-view'

/**
 * Log › Stream: the DCS-BIOS rows the Log tab picked (filtered, newest first, capped), one line
 * each. `rawMode` shows the address and raw bytes.
 */
export function StreamView({ rows, rawMode }: { rows: LogRow[]; rawMode: boolean }) {
  return (
    <>
      {rows.map((r) => (
        <div className="log__grid log__row" key={r.id}>
          <span className="log__time">{r.time}</span>
          <span
            className="log__dir"
            style={{ color: r.dir === 'in' ? 'var(--green)' : 'var(--blue)' }}
          >
            {r.dir === 'in' ? 'IN ▸' : '◂ OUT'}
          </span>
          <span className="log__name">{rawMode ? r.addrHex : r.name}</span>
          <span
            className="log__val"
            style={{
              color: rawMode ? 'var(--muted-4)' : r.dir === 'out' ? 'var(--blue)' : '#cdd6e6'
            }}
          >
            {rawMode ? r.raw : String(r.value)}
          </span>
        </div>
      ))}
    </>
  )
}
