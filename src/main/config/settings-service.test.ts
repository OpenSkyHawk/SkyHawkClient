// FILE-seam contract test (Phase 0, row B97): config.json as main reads and writes it in <userData>.
// It pins today's behaviour: a tolerant read (anything wrong loads the defaults) and a best-effort
// write (a failure is swallowed, so a read-only userData folder never crashes the app).
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
import { loadConfig, saveConfig, type SettingsPaths } from './settings-service'

let dir = ''
// <userData> is handed in the way app hands it in.
const paths = storePaths(() => dir)
const file = (): string => join(dir, 'config.json')

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
    const cfg = loadConfig(paths)
    expect(cfg).toEqual(DEFAULT_CONFIG)
    expect(cfg).not.toBe(DEFAULT_CONFIG)
    expect(readdirSync(dir)).toEqual([])
  })

  it('a damaged file loads the defaults and is left where it is', () => {
    writeFileSync(file(), '{"debugMode":tr')
    expect(loadConfig(paths)).toEqual(DEFAULT_CONFIG)
    expect(readdirSync(dir)).toEqual(['config.json'])
    expect(readFileSync(file(), 'utf8')).toBe('{"debugMode":tr')
  })

  it('an unreadable file (here a folder) loads the defaults', () => {
    mkdirSync(file())
    expect(loadConfig(paths)).toEqual(DEFAULT_CONFIG)
  })

  it('a file that is valid JSON but not a config is coerced field by field', () => {
    writeFileSync(file(), JSON.stringify({ debugMode: true, host: 42, sourceMode: 'nope' }))
    expect(loadConfig(paths)).toEqual({ ...DEFAULT_CONFIG, debugMode: true })
    writeFileSync(file(), 'null')
    expect(loadConfig(paths)).toEqual(DEFAULT_CONFIG)
  })

  it('save writes what load reads back, pretty-printed, in place (no temp file)', () => {
    saveConfig(custom, paths)
    expect(readdirSync(dir)).toEqual(['config.json'])
    expect(readFileSync(file(), 'utf8')).toBe(JSON.stringify(custom, null, 2))
    expect(loadConfig(paths)).toEqual(custom)
  })

  it('a failed write is swallowed: no throw, nothing written', () => {
    const nowhere: SettingsPaths = { configFile: () => join(dir, 'missing', 'config.json') }
    expect(() => saveConfig(custom, nowhere)).not.toThrow()
    expect(readdirSync(dir)).toEqual([])
  })

  it.skipIf(process.getuid?.() === 0)(
    'a read-only file is not rewritten, and the failure is swallowed',
    () => {
      saveConfig(custom, paths)
      chmodSync(file(), 0o400)
      expect(() => saveConfig(DEFAULT_CONFIG, paths)).not.toThrow()
      expect(loadConfig(paths)).toEqual(custom)
      chmodSync(file(), 0o600)
    }
  )

  it('a path that cannot be resolved loads the defaults and saves nothing, without throwing', () => {
    const broken: SettingsPaths = {
      configFile: () => {
        throw new Error('no userData')
      }
    }
    expect(loadConfig(broken)).toEqual(DEFAULT_CONFIG)
    expect(() => saveConfig(custom, broken)).not.toThrow()
  })
})
