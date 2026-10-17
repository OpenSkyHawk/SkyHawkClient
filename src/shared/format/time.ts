// Time helpers: clock times, dates, ages and durations. Local time unless the name says otherwise.

/** Two digits: `7` → `07`. */
export const pad = (n: number) => String(n).padStart(2, '0')

/** Three digits: `7` → `007`. */
export const pad3 = (n: number) => String(n).padStart(3, '0')

/** `21:14:07.412`. */
export function fmtTime(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad3(d.getMilliseconds())}`
}

/** `21:14:07`: fmtTime without the milliseconds. */
export const hhmmss = (ms: number) => fmtTime(ms).slice(0, 8)

/** `21:14`. */
export const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `2026-10-16`. */
export const day = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `2026-10-16 21:14:07.412`. */
export function fmtDateTime(t: number): string {
  const d = new Date(t)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad3(d.getMilliseconds())}`
  )
}

/** "14 Oct, 21:14": when a remembered board was last on the bus (#93). */
export function lastSeenLabel(t: number): string {
  return new Date(t).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** "first seen 2 min ago" — this session's first sighting (it is not persisted). */
export function seenAgo(firstSeenAt: number | undefined, now: number): string {
  if (firstSeenAt === undefined) return 'first seen this session'
  const s = Math.max(0, Math.round((now - firstSeenAt) / 1000))
  if (s < 60) return 'first seen just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `first seen ${m} min ago`
  return `first seen ${Math.floor(m / 60)} h ago`
}

/** Seconds as `HH:MM:SS`; hours keep counting past 99. */
export function fmtUptime(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${pad(h)}:${pad(m)}:${pad(sec)}`
}

/** UTC ISO time made safe for a file name: `2026-10-16T10-00-00-000Z`. */
export const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, '-')
