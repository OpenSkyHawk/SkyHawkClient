import { useEffect, useState } from 'react'

/** The clock, every `everyMs` while `on` — for "updated N s ago", "checked 2 min ago". */
export function useNow(on: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [on, everyMs])
  return now
}
