// FILE-seam contract test (Phase 0, row B97): config.json as main reads and writes it in <userData>.
// It pins the behaviour since #136: a tolerant read (a file that cannot be loaded falls back to
// config.json.bak, and to the defaults when that fails too) and a write that never throws (a
// read-only userData folder never crashes the app). Neither goes wrong silently: each problem is
// one event-log row.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type AppConfig } from '@shared/config'
import { storePaths } from '../app/user-data'
import {
  loadConfig,
  saveConfig,
  SettingsService,
  type SettingsFileEvents,
  type SettingsPaths
} from './settings-service'

let dir = ''
// <userData> is handed in the way app hands it in.
const paths = storePaths(() => dir)
const file = (): string => join(dir, 'config.json')
const bak = (): string => join(dir, 'config.json.bak')

/** The event log as config.json reports to it, deduped per tag the way EventJournal.error is. */
function eventLog() {
  const rows: string[] = []
  const last = new Map<string, string>()
  /** `<severity> <tag>: <message>`, deduped per tag across both severities. */
  const add = (severity: string, tag: string, msg: string) => {
    if (last.get(tag) === msg) return
    last.set(tag, msg)
    rows.push(`${severity} ${tag}: ${msg}`)
  }
  const events: SettingsFileEvents = {
    error: (tag, msg) => add('error', tag, msg),
    warn: (tag, msg) => add('warn', tag, msg),
    forget: (tag) => last.delete(tag)
  }
  return { rows, events }
}
const badCopy = (): string => readdirSync(dir).find((f) => f.startsWith('config.json.bad-'))!

const custom: AppConfig = {
  ...DEFAULT_CONFIG,
  sourceMode: 'bridge',
  host: '10.0.0.7',
  listenPort: 7777,
  debugMode: true,
  attentionBanner: false
}

describe('B97 config.json load / save round trip', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skyhawk-settings-'))
  })
  afterEach(() => {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  })

  it('a missing file loads the defaults, as a fresh copy, and writes nothing', () => {
    const log = eventLog()
    const cfg = loadConfig(paths, log.events)
    expect(cfg).toEqual(DEFAULT_CONFIG)
    expect(cfg).not.toBe(DEFAULT_CONFIG)
    expect(readdirSync(dir)).toEqual([])
    expect(log.rows).toEqual([])
  })

  it('a damaged file with no backup loads the defaults, is kept aside, and logs a row', () => {
    writeFileSync(file(), '{"debugMode":tr')
    const log = eventLog()
    expect(loadConfig(paths, log.events)).toEqual(DEFAULT_CONFIG)
    expect(readdirSync(dir)).toEqual([badCopy()])
    expect(readFileSync(join(dir, badCopy()), 'utf8')).toBe('{"debugMode":tr')
    expect(log.rows).toEqual([
      `error config.json: config.json is damaged, and there is no backup. The bad copy was kept as ` +
        `${badCopy()}. Using the default settings.`
    ])
  })

  it('an unreadable file (here a folder) with no backup loads the defaults, and logs a row', () => {
    mkdirSync(file())
    const log = eventLog()
    expect(loadConfig(paths, log.events)).toEqual(DEFAULT_CONFIG)
    expect(log.rows).toHaveLength(1)
    expect(log.rows[0]).toMatch(
      /^error config\.json: config\.json could not be read \(EISDIR: .*\), and there is no backup\. Using the default settings\.$/
    )
  })

  it('a damaged file falls back to config.json.bak, logging which file did', () => {
    saveConfig(custom, paths)
    saveConfig({ ...custom, host: '10.0.0.8' }, paths) // config.json.bak = custom
    writeFileSync(file(), '{"debugMode":tr')
    const log = eventLog()
    expect(loadConfig(paths, log.events)).toEqual(custom)
    expect(log.rows).toEqual([
      `warn config.json: config.json is damaged. Loaded the backup, config.json.bak. The bad copy was ` +
        `kept as ${badCopy()}.`
    ])
    expect(readFileSync(join(dir, badCopy()), 'utf8')).toBe('{"debugMode":tr')
    expect(loadConfig(paths, log.events)).toEqual(custom) // the backup is back in place
    expect(log.rows).toHaveLength(1)
  })

  it('a damaged file and a damaged backup load the defaults, and log a row', () => {
    writeFileSync(file(), '{"debugMode":tr')
    writeFileSync(bak(), '{"host":')
    const log = eventLog()
    expect(loadConfig(paths, log.events)).toEqual(DEFAULT_CONFIG)
    expect(log.rows).toEqual([
      `error config.json: config.json is damaged, and its backup is damaged too. The bad copy was kept ` +
        `as ${badCopy()}. Using the default settings.`
    ])
  })

  it('a file that is valid JSON but not a config is coerced field by field', () => {
    writeFileSync(file(), JSON.stringify({ debugMode: true, host: 42, sourceMode: 'nope' }))
    expect(loadConfig(paths)).toEqual({ ...DEFAULT_CONFIG, debugMode: true })
    writeFileSync(file(), 'null')
    expect(loadConfig(paths)).toEqual(DEFAULT_CONFIG)
  })

  it('save writes what load reads back, pretty-printed, leaving no temp file', () => {
    saveConfig(custom, paths)
    expect(readdirSync(dir)).toEqual(['config.json'])
    expect(readFileSync(file(), 'utf8')).toBe(JSON.stringify(custom, null, 2))
    expect(loadConfig(paths)).toEqual(custom)
  })

  it('a failed write does not throw and writes nothing, but logs a row', () => {
    const nowhere: SettingsPaths = { configFile: () => join(dir, 'missing', 'config.json') }
    const log = eventLog()
    expect(() => saveConfig(custom, nowhere, log.events)).not.toThrow()
    expect(readdirSync(dir)).toEqual([])
    expect(log.rows).toHaveLength(1)
    expect(log.rows[0]).toMatch(/^error config\.json: config\.json could not be saved: ENOENT: /)
  })

  it.skipIf(process.getuid?.() === 0)(
    'a read-only userData folder: the file is not rewritten, no throw, one row per failure',
    () => {
      saveConfig(custom, paths)
      chmodSync(dir, 0o500)
      const log = eventLog()
      expect(() => saveConfig(DEFAULT_CONFIG, paths, log.events)).not.toThrow()
      saveConfig({ ...DEFAULT_CONFIG, host: 'x' }, paths, log.events) // the same failure again
      expect(log.rows).toHaveLength(1) // deduped per file
      expect(log.rows[0]).toMatch(/^error config\.json: config\.json could not be saved: EACCES: /)
      expect(loadConfig(paths)).toEqual(custom)
      // A write that works makes the next failure news again.
      chmodSync(dir, 0o700)
      saveConfig(custom, paths, log.events)
      chmodSync(dir, 0o500)
      saveConfig(DEFAULT_CONFIG, paths, log.events)
      expect(log.rows).toHaveLength(2)
    }
  )

  it.skipIf(process.getuid?.() === 0)(
    'SettingsService: a change whose save fails still applies in memory, and is logged',
    () => {
      chmodSync(dir, 0o500)
      const log = eventLog()
      const service = new SettingsService({ paths, events: log.events, debugMode: () => {} })
      expect(service.apply({ host: '10.0.0.9' }).host).toBe('10.0.0.9')
      expect(service.get().host).toBe('10.0.0.9')
      expect(log.rows).toHaveLength(1)
    }
  )

  it('a path that cannot be resolved loads the defaults and saves nothing, without throwing', () => {
    const broken: SettingsPaths = {
      configFile: () => {
        throw new Error('no userData')
      }
    }
    const log = eventLog()
    expect(loadConfig(broken, log.events)).toEqual(DEFAULT_CONFIG)
    expect(() => saveConfig(custom, broken, log.events)).not.toThrow()
    expect(log.rows).toEqual([]) // no <userData> at all is not a file problem
  })
})
