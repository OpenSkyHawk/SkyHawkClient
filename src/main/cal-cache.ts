// Persist the calibration cache to <userData>/calibration-cache.json (#46, part 5).
//
// Deliberately the same shape as settings.ts: tolerant read, best-effort write. A read-only
// userData directory must not crash the app, and it must not break calibration either — the cache
// is a recovery aid, so failing to keep one leaves the user exactly where they were, whereas
// throwing would break the write that had already succeeded on the device.
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { emptyCache, sanitizeCache, type CalCache } from '@shared/cal-cache'

function cachePath(): string {
  return join(app.getPath('userData'), 'calibration-cache.json')
}

export function loadCalCache(): CalCache {
  try {
    const p = cachePath()
    if (!existsSync(p)) return emptyCache()
    return sanitizeCache(JSON.parse(readFileSync(p, 'utf8')))
  } catch {
    return emptyCache()
  }
}

export function saveCalCache(cache: CalCache): void {
  try {
    writeFileSync(cachePath(), JSON.stringify(cache, null, 2))
  } catch {
    // best-effort; see the note at the top of this file
  }
}
