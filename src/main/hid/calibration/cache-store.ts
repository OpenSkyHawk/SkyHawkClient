// Persist the calibration cache to <userData>/calibration-cache.json (#46, part 5).
//
// Deliberately the same shape as settings-service.ts: tolerant read, a write that never throws. A
// read-only userData directory must not crash the app, and it must not break calibration either —
// the cache is a recovery aid, so failing to keep one leaves the user exactly where they were,
// whereas throwing would break the write that had already succeeded on the device. What went wrong
// is an event row (CacheFileEvents), never silent.
//
// The file itself is reached through CacheFileIO, which app wires to the JSON store (fsync, `.bak`,
// a bad file falls back to its backup and is moved aside).
import { emptyCache, sanitizeCache } from './cache-rules'
import type { CalCache } from '@shared/hid/calibration'
import { fileErrorText } from '@shared/format'

/**
 * Port: calibration-cache.json. `read` resolves the path and reports what it found, `note` saying
 * what went wrong (a throw means the path could not be resolved); `write` returns the failure —
 * its error and its `note` — when the file did not reach the disk (a throw means the path could
 * not be resolved).
 */
export interface CacheFileIO {
  read():
    | { kind: 'read'; data: unknown }
    | { kind: 'missing' }
    | { kind: 'fallback'; data: unknown; note: string }
    | { kind: 'failed'; note: string }
  write(cache: CalCache): { error: unknown; note: string } | undefined
}

/**
 * Port: the event log, as calibration-cache.json reports to it (app wires the EventJournal).
 * `error` is a client error row, deduped per tag; `forget` makes the tag's next error news again.
 */
export interface CacheFileEvents {
  error(tag: string, message: string): void
  /** The same row at warn: recovered, nothing lost. Same tag and dedupe as `error`. */
  warn(tag: string, message: string): void
  forget(tag: string): void
}

/** The event-log tag of calibration-cache.json's rows. */
export const CACHE_FILE_TAG = 'calibration-cache.json'

const NO_EVENTS: CacheFileEvents = { error: () => {}, warn: () => {}, forget: () => {} }

export function loadCalCache(io: CacheFileIO, events = NO_EVENTS): CalCache {
  try {
    const r = io.read()
    switch (r.kind) {
      case 'read':
        return sanitizeCache(r.data)
      case 'fallback': // loaded from the backup: nothing lost, a warn row
        events.warn(CACHE_FILE_TAG, r.note)
        return sanitizeCache(r.data)
      case 'failed':
        events.error(CACHE_FILE_TAG, `${r.note} Starting with an empty calibration cache.`)
        return emptyCache()
      case 'missing':
        return emptyCache()
    }
  } catch {
    return emptyCache() // the path could not be resolved: nothing was read
  }
}

/**
 * Never throws; see the note at the top of this file. One row per failure until a write works.
 * Says why, in plain words, when the file did not reach the disk — the reason alone, which a config
 * import (it must not report a section saved that was not) puts after its section's title; the
 * calibration flow ignores it.
 */
export function saveCalCache(
  cache: CalCache,
  io: CacheFileIO,
  events = NO_EVENTS
): string | undefined {
  let failed: { error: unknown; note: string } | undefined
  try {
    failed = io.write(cache)
  } catch (err) {
    // the path could not be resolved: nothing was written
    return fileErrorText(err)
  }
  if (failed) events.error(CACHE_FILE_TAG, failed.note)
  else events.forget(CACHE_FILE_TAG)
  return failed && fileErrorText(failed.error)
}
