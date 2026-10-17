// One import transaction (C2/M10) against the real stores and real files: NodeHub's mapping, the
// calibration copy and SettingsService, each file in a folder of its own so one can be made
// read-only. Whichever target cannot be written, every file on disk — and its `.bak`, which the
// rolled-back writes rotated — is byte for byte as it was before the import, no file is left that
// was not there, the live settings are unchanged, and the answer names the section that failed.
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_FORMAT, DEFAULT_CONFIG, type AppConfig } from '@shared/config'
import type { NodeMappingFile } from '@shared/nodes'
import type { CalCache } from '@shared/hid/calibration'
import { jsonFile } from './json-store'
import { SettingsService } from './settings-service'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } })) // debug log path
const { NodeHub, NodeRoster } = await import('../nodes')
const { loadCalCache, saveCalCache } = await import('../hid/calibration')
const { ConfigTransfer } = await import('./config-transfer')

const axis = (min: number, centre: number, max: number) => ({
  min,
  centre,
  max,
  selfCentring: true
})

const MAPPING: NodeMappingFile = {
  version: 3,
  nodes: { 41: { name: 'Trim', console: 'Left', pduId: null, kind: 'panel' } }
}
const CACHE: CalCache = {
  version: 1,
  boards: { A7: { confirmedAt: '2026-10-14T00:00:00Z', axes: { 2: axis(4, 5, 6) } } }
}
const CONFIG: AppConfig = { ...DEFAULT_CONFIG, host: '10.0.0.9' }

/** The file to import: every section differs from what is on disk. */
const FILE = JSON.stringify({
  format: CONFIG_FORMAT,
  version: 1,
  sections: {
    app: { ...DEFAULT_CONFIG, psu: undefined, host: '10.0.0.2' },
    nodeMapping: { version: 3, nodes: { 2: { added: true, name: 'Nav' } } },
    powerSupply: { mode: 'custom', preset: 'nx650', custom: { a12: 40 } },
    calibration: {
      version: 1,
      boards: { A7: { confirmedAt: '2026-10-12T00:00:00Z', axes: { 0: axis(1, 2, 3) } } }
    }
  }
})
const ALL = ['app', 'nodeMapping', 'powerSupply', 'calibration']

let dirs: { mapping: string; cache: string; config: string; backups: string }
const files = () => ({
  mapping: join(dirs.mapping, 'node-mapping.json'),
  cache: join(dirs.cache, 'calibration-cache.json'),
  config: join(dirs.config, 'config.json')
})
/** A file's bytes (hex), or null when there is none. */
const bytes = (p: string) => (existsSync(p) ? readFileSync(p).toString('hex') : null)
/** Each file and its `.bak`, byte for byte, and every name in the three folders. */
const onDisk = () => {
  const f = files()
  const each = (p: string) => ({ file: bytes(p), bak: bytes(`${p}.bak`) })
  return {
    mapping: each(f.mapping),
    cache: each(f.cache),
    config: each(f.config),
    names: [dirs.mapping, dirs.cache, dirs.config].map((d) => readdirSync(d).sort())
  }
}

function launch() {
  const f = files()
  const cacheFile = jsonFile(() => f.cache)
  const settings = new SettingsService({
    paths: { configFile: () => f.config },
    debugMode: () => {}
  })
  settings.load()
  const nodes = new NodeHub(
    () => {},
    new NodeRoster(),
    () => {},
    {
      mappingFile: jsonFile(() => f.mapping)
    }
  )
  const transfer = new ConfigTransfer({
    getConfig: () => settings.get(),
    replaceConfig: (c) => settings.replace(c),
    nodes,
    loadCalCache: () => loadCalCache(cacheFile),
    saveCalCache: (c) => saveCalCache(c, cacheFile),
    files: {
      mapping: jsonFile(() => f.mapping),
      calibration: cacheFile,
      config: jsonFile(() => f.config)
    },
    backupDir: () => dirs.backups,
    clientVersion: () => '0.2.0',
    now: () => new Date('2026-10-16T10:00:00Z')
  })
  return { settings, nodes, transfer }
}

const ready = (r: ReturnType<InstanceType<typeof ConfigTransfer>['preview']>) => {
  if (r.status !== 'ready') throw new Error(JSON.stringify(r))
  return r.preview
}

describe.skipIf(process.getuid?.() === 0)('an import is one transaction, on real files', () => {
  beforeEach(() => {
    const dir = () => mkdtempSync(join(tmpdir(), 'skyhawk-tx-'))
    dirs = { mapping: dir(), cache: dir(), config: dir(), backups: dir() }
    const f = files()
    // Each saved twice through the store, as the app writes it: so each has a `.bak` (the older
    // version) for a rollback to keep.
    jsonFile(() => f.mapping).write({ version: 3, nodes: {} })
    jsonFile(() => f.mapping).write(MAPPING)
    jsonFile(() => f.cache).write({ version: 1, boards: {} })
    jsonFile(() => f.cache).write(CACHE)
    jsonFile(() => f.config).write(DEFAULT_CONFIG)
    jsonFile(() => f.config).write(CONFIG)
  })
  afterEach(() => {
    for (const d of Object.values(dirs)) {
      chmodSync(d, 0o700)
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('all targets written: the import lands whole', () => {
    const { transfer, settings, nodes } = launch()
    const p = ready(transfer.preview(FILE, '/x/a.json'))
    expect(transfer.apply(p.token, ALL, false)).toMatchObject({ ok: true, applied: ALL })
    expect(settings.get().host).toBe('10.0.0.2')
    expect(nodes.mappingFile().nodes).toEqual({ 2: { added: true, name: 'Nav' } })
    expect(Object.keys(JSON.parse(readFileSync(files().cache, 'utf8')).boards.A7.axes)).toEqual([
      '0',
      '2'
    ])
  })

  for (const [target, title] of [
    ['mapping', 'Node mapping'],
    ['cache', 'Axis calibration'],
    ['config', 'App settings and Power supply']
  ] as const) {
    it(`${target} cannot be written: every file is as before, and the answer says which`, () => {
      const { transfer, settings, nodes } = launch()
      const p = ready(transfer.preview(FILE, '/x/a.json'))
      const before = onDisk()
      chmodSync(dirs[target], 0o500) // read-only: its write fails, the others' work
      const r = transfer.apply(p.token, ALL, false)
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error).toMatch(
        new RegExp(`^Nothing was changed — ${title} could not be saved: `)
      )
      expect(onDisk()).toEqual(before) // byte for byte, `.bak` too: nothing half-applied
      expect(settings.get()).toEqual(CONFIG)
      expect(nodes.mappingFile()).toEqual(MAPPING)
    })
  }

  it('a file that did not exist before the import is gone again after its rollback', () => {
    const f = files()
    rmSync(f.cache)
    rmSync(`${f.cache}.bak`)
    const { transfer } = launch()
    const p = ready(transfer.preview(FILE, '/x/a.json'))
    const before = onDisk()
    expect(before.cache).toEqual({ file: null, bak: null })
    chmodSync(dirs.config, 0o500) // the settings fail last: calibration-cache.json was created
    expect(transfer.apply(p.token, ALL, false)).toMatchObject({ ok: false })
    expect(onDisk()).toEqual(before)
  })
})
