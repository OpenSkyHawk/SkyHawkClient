// Persist the calibration cache to <userData>/calibration-cache.json (#46, part 5).
//
// Deliberately the same shape as settings-service.ts: tolerant read, best-effort write. A read-only
// userData directory must not crash the app, and it must not break calibration either — the cache
// is a recovery aid, so failing to keep one leaves the user exactly where they were, whereas
// throwing would break the write that had already succeeded on the device.
//
// The file itself is reached through CacheFileIO, which app wires to the JSON store under
// calibration-cache.json's policy (written in place, failures swallowed, a damaged file left as is).
import { emptyCache, sanitizeCache } from './cache-rules'
import type { CalCache } from '@shared/hid/calibration'

/**
 * Port: calibration-cache.json. `read` resolves the path and reports what it found (a throw means
 * the path could not be resolved); `write` is best effort and never throws.
 */
export interface CacheFileIO {
  read(): { kind: 'read'; data: unknown } | { kind: 'missing' | 'unreadable' | 'damaged' }
  write(cache: CalCache): void
}

export function loadCalCache(io: CacheFileIO): CalCache {
  try {
    const r = io.read()
    return r.kind === 'read' ? sanitizeCache(r.data) : emptyCache()
  } catch {
    return emptyCache()
  }
}

export function saveCalCache(cache: CalCache, io: CacheFileIO): void {
  io.write(cache) // best effort, by the file's policy; see the note at the top of this file
}
