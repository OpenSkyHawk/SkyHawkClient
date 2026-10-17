// calibration-cache.json as main reads and writes it in <userData> (#46 part 5; #136): a tolerant
// read that falls back to calibration-cache.json.bak, and a write that never throws. Each problem
// is one event-log row.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CalCache } from '@shared/hid/calibration'
import { storeFiles, storePaths } from '../../app/user-data'
import { emptyCache } from './cache-rules'
import { loadCalCache, saveCalCache, type CacheFileEvents } from './cache-store'

let dir = ''
// The port app wires: the JSON store, at the path app hands in.
const io = storeFiles(storePaths(() => dir)).cacheFile
const file = (): string => join(dir, 'calibration-cache.json')

const cache = (min: number): CalCache => ({
  version: 1,
  boards: {
    SERIAL1: {
      confirmedAt: '2026-10-17T00:00:00.000Z',
      axes: { 0: { min, centre: 2048, max: 4000, selfCentring: true } }
    }
  }
})

function eventLog() {
  const rows: string[] = []
  const last = new Map<string, string>()
  /** `<severity> <tag>: <message>`, deduped per tag across both severities. */
  const add = (severity: string, tag: string, msg: string) => {
    if (last.get(tag) === msg) return
    last.set(tag, msg)
    rows.push(`${severity} ${tag}: ${msg}`)
  }
  const events: CacheFileEvents = {
    error: (tag, msg) => add('error', tag, msg),
    warn: (tag, msg) => add('warn', tag, msg),
    forget: (tag) => last.delete(tag)
  }
  return { rows, events }
}
const badCopy = (): string =>
  readdirSync(dir).find((f) => f.startsWith('calibration-cache.json.bad-'))!

describe('calibration-cache.json', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skyhawk-cal-cache-'))
  })
  afterEach(() => {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips, keeping the previous file as .bak', () => {
    saveCalCache(cache(10), io)
    saveCalCache(cache(20), io)
    expect(loadCalCache(io)).toEqual(cache(20))
    expect(readdirSync(dir).sort()).toEqual([
      'calibration-cache.json',
      'calibration-cache.json.bak'
    ])
  })

  it('a damaged file falls back to the backup, logging which file did', () => {
    saveCalCache(cache(10), io)
    saveCalCache(cache(20), io) // .bak = cache(10)
    writeFileSync(file(), '{"version":1,"bo')
    const log = eventLog()
    expect(loadCalCache(io, log.events)).toEqual(cache(10))
    expect(log.rows).toEqual([
      `warn calibration-cache.json: calibration-cache.json is damaged. Loaded the backup, ` +
        `calibration-cache.json.bak. The bad copy was kept as ${badCopy()}.`
    ])
    // The cache is read on every use: the backup is back in place, so the next read is quiet.
    expect(loadCalCache(io, log.events)).toEqual(cache(10))
    expect(log.rows).toHaveLength(1)
  })

  it('a damaged file and no backup: an empty cache, and a row', () => {
    writeFileSync(file(), '{"version":1,"bo')
    const log = eventLog()
    expect(loadCalCache(io, log.events)).toEqual(emptyCache())
    expect(log.rows).toEqual([
      `error calibration-cache.json: calibration-cache.json is damaged, and there is no backup. The bad ` +
        `copy was kept as ${badCopy()}. Starting with an empty calibration cache.`
    ])
  })

  it.skipIf(process.getuid?.() === 0)(
    'a failed write never throws; one row per failure until a write works again',
    () => {
      saveCalCache(cache(10), io)
      chmodSync(dir, 0o500)
      const log = eventLog()
      expect(() => saveCalCache(cache(20), io, log.events)).not.toThrow()
      saveCalCache(cache(30), io, log.events)
      expect(log.rows).toHaveLength(1)
      expect(log.rows[0]).toBe(
        `error calibration-cache.json: calibration-cache.json could not be saved (permission ` +
          `denied in ${dir})`
      )
      expect(loadCalCache(io)).toEqual(cache(10))
      chmodSync(dir, 0o700)
      saveCalCache(cache(40), io, log.events) // works: forgotten
      chmodSync(dir, 0o500)
      saveCalCache(cache(50), io, log.events)
      expect(log.rows).toHaveLength(2)
    }
  )

  it.skipIf(process.getuid?.() === 0)(
    'a save says why it did not reach the disk (a config import reads it, C2/M10)',
    () => {
      expect(saveCalCache(cache(10), io)).toBeUndefined()
      chmodSync(dir, 0o500)
      // The reason alone: a config import puts it after its section's title.
      expect(saveCalCache(cache(20), io)).toBe(`permission denied in ${dir}`)
      chmodSync(dir, 0o700)
      const broken = storeFiles(
        storePaths(() => {
          throw new Error('no userData')
        })
      ).cacheFile
      expect(saveCalCache(cache(1), broken)).toBe('no userData')
    }
  )

  it('a path that cannot be resolved reads empty and saves nothing, without a throw or a row', () => {
    const broken = storeFiles(
      storePaths(() => {
        throw new Error('no userData')
      })
    ).cacheFile
    const log = eventLog()
    expect(loadCalCache(broken, log.events)).toEqual(emptyCache())
    expect(() => saveCalCache(cache(1), broken, log.events)).not.toThrow()
    expect(log.rows).toEqual([])
  })
})
