// Persist the calibration cache to <userData>/calibration-cache.json (#46, part 5).
//
// Where that file lives is handed in by app (CachePaths): this module never asks electron.
//
// Deliberately the same shape as config/settings-service.ts: tolerant read, best-effort write. A
// read-only userData directory must not crash the app, and it must not break calibration either —
// the cache is a recovery aid, so failing to keep one leaves the user exactly where they were,
// whereas throwing would break the write that had already succeeded on the device.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { emptyCache, sanitizeCache } from '@shared/cal-cache'
import type { CalCache } from '@shared/hid/calibration/ipc'

/** Port: where calibration-cache.json lives. app provides it; resolved at each use, as before. */
export interface CachePaths {
  calibrationCacheFile(): string
}

export function loadCalCache(paths: CachePaths): CalCache {
  try {
    const p = paths.calibrationCacheFile()
    if (!existsSync(p)) return emptyCache()
    return sanitizeCache(JSON.parse(readFileSync(p, 'utf8')))
  } catch {
    return emptyCache()
  }
}

export function saveCalCache(cache: CalCache, paths: CachePaths): void {
  try {
    writeFileSync(paths.calibrationCacheFile(), JSON.stringify(cache, null, 2))
  } catch {
    // best-effort; see the note at the top of this file
  }
}
