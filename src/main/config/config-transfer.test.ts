import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type AppConfig, type ImportPreview } from '@shared/config'
import { registryDefaults } from '../nodes/registry'
import type { NodeMappingFile } from '@shared/nodes'
import type { CalCache } from '@shared/hid/calibration'
import { ConfigTransfer, type ConfigTransferDeps } from './config-transfer'

const defaults = registryDefaults({
  1: { name: 'Center_Armament', console: 'Center' },
  3: { name: 'PDU_Left', console: 'Left' },
  5: { name: 'PDU_Center', console: 'Center' }
})
const axis = (min: number, centre: number, max: number) => ({
  min,
  centre,
  max,
  selfCentring: true
})

let dir: string
type Target = 'mapping' | 'calibration' | 'config'
let state: {
  config: AppConfig
  mapping: NodeMappingFile
  cache: CalCache
  mappingRefuses?: string
  /** Failure injection: the writes (1-based, per target) that fail, saying `<target> write <n>`. */
  fail: Partial<Record<Target, number[]>>
  /** Failure injection: the targets whose byte copy cannot be taken, or put back. */
  copyFails?: Partial<Record<Target, 'snapshot' | 'restore'>>
  writes: Record<Target, number>
  calls: string[]
}

/** Whether this write of `target` is one the test makes fail; why, if so. */
function injected(target: Target): string | undefined {
  const n = ++state.writes[target]
  return state.fail[target]?.includes(n) ? `${target} write ${n} failed` : undefined
}

/**
 * A target's file as the JSON store copies it: its "bytes" are the store's value, and putting
 * them back sets the value (the real byte-for-byte copy is config-transfer.files.test.ts's).
 */
function fileCopy(target: Target, key: 'mapping' | 'cache' | 'config') {
  return {
    snapshot: () => {
      if (state.copyFails?.[target] === 'snapshot') throw new Error(`${target} unreadable`)
      return { file: Buffer.from(JSON.stringify(state[key])), bak: null }
    },
    restore: (copy: { file: Buffer | null }) => {
      if (state.copyFails?.[target] === 'restore') {
        return { error: new Error('x'), note: `${target} could not be put back: EROFS` }
      }
      state.calls.push(`restore ${target}`)
      ;(state as Record<string, unknown>)[key] = JSON.parse(copy.file!.toString())
      return undefined
    }
  }
}

function transfer(over: Partial<ConfigTransferDeps> = {}) {
  return new ConfigTransfer({
    getConfig: () => state.config,
    replaceConfig: (c) => {
      const failed = injected('config')
      if (failed) return { ok: false, error: failed }
      state.calls.push('config')
      return { ok: true, config: (state.config = c) }
    },
    nodes: {
      mappingFile: () => state.mapping,
      registryDefaults: () => defaults,
      onlineIds: () => [],
      replaceMapping: (f) => {
        if (state.mappingRefuses) return { ok: false, error: state.mappingRefuses }
        const failed = injected('mapping')
        if (failed) return { ok: false, error: failed }
        state.calls.push('mapping')
        state.mapping = f
        return { ok: true, model: {} as never }
      }
    },
    loadCalCache: () => state.cache,
    saveCalCache: (c) => {
      const failed = injected('calibration')
      if (failed) return failed
      state.calls.push('calibration')
      state.cache = c
      return undefined
    },
    files: {
      mapping: fileCopy('mapping', 'mapping'),
      calibration: fileCopy('calibration', 'cache'),
      config: fileCopy('config', 'config')
    },
    backupDir: () => join(dir, 'backups'),
    clientVersion: () => '0.2.0',
    now: () => new Date('2026-10-16T10:00:00Z'),
    ...over
  })
}

/** An export of a setup that differs from `state` in every section. */
function otherSetupFile(): string {
  const saved = state
  state = {
    config: {
      ...DEFAULT_CONFIG,
      host: '10.0.0.2',
      psu: { mode: 'custom', preset: 'nx650', custom: { a12: 40 } }
    },
    // 52: an adopted board, hidden (S4: only a board in your cockpit carries a hidden flag).
    mapping: {
      version: 3,
      nodes: {
        1: { name: 'Arm' },
        52: { name: 'Trim', console: 'Left', pduId: null, kind: 'panel', hidden: true }
      }
    },
    cache: {
      version: 1,
      boards: { A7: { confirmedAt: '2026-10-12T00:00:00Z', axes: { 0: axis(1, 2, 3) } } }
    },
    fail: {},
    writes: { mapping: 0, calibration: 0, config: 0 },
    calls: []
  }
  const text = transfer().exportText()
  state = saved
  return text
}

const ready = (r: ReturnType<ConfigTransfer['preview']>): ImportPreview => {
  if (r.status !== 'ready') throw new Error(`expected a preview, got ${JSON.stringify(r)}`)
  return r.preview
}

describe('ConfigTransfer', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skyhawk-transfer-'))
    state = {
      config: DEFAULT_CONFIG,
      mapping: { version: 3, nodes: {} },
      cache: {
        version: 1,
        boards: { A7: { confirmedAt: '2026-10-14T00:00:00Z', axes: { 2: axis(4, 5, 6) } } }
      },
      fail: {},
      writes: { mapping: 0, calibration: 0, config: 0 },
      calls: []
    }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('an export of the current setup previews as identical', () => {
    const t = transfer()
    const p = ready(t.preview(t.exportText(), '/x/skyhawk-config-2026-10-16.json'))
    expect(p).toMatchObject({
      fileName: 'skyhawk-config-2026-10-16.json',
      client: '0.2.0',
      identical: true
    })
    expect(t.defaultFileName()).toBe('skyhawk-config-2026-10-16.json')
  })

  it('an export says what came of it: saved, cancelled or failed (R3.4a)', () => {
    const t = transfer()
    const file = join(dir, 'out.json')
    expect(t.exportTo(file)).toEqual({ outcome: 'saved', path: file })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ client: '0.2.0' })
    expect(t.exportTo(undefined)).toEqual({ outcome: 'canceled' })
    const r = t.exportTo(join(dir, 'missing', 'out.json'))
    expect(r.outcome).toBe('failed')
    expect(r.outcome === 'failed' && r.error).toMatch(/^Could not write the file: ENOENT/)
  })

  it('an invalid file is refused and leaves nothing to apply', () => {
    const t = transfer()
    expect(t.preview('{}', '/x/a.json')).toEqual({
      status: 'error',
      error: 'This is not an OpenSkyhawk Client configuration file.'
    })
    expect(t.apply('anything', ['app'], false)).toMatchObject({ ok: false })
  })

  it('applies only the picked sections, after a backup of the current setup', () => {
    const t = transfer()
    const p = ready(t.preview(otherSetupFile(), '/x/a.json'))
    expect(p.identical).toBe(false)
    const r = t.apply(p.token, ['powerSupply', 'calibration', 'nodeMapping'], true)
    expect(r).toMatchObject({ ok: true, applied: ['nodeMapping', 'powerSupply', 'calibration'] })
    expect(state.calls).toEqual(['mapping', 'calibration', 'config'])
    expect(state.config.host).toBe('127.0.0.1') // app settings were not picked
    expect(state.config.psu.mode).toBe('custom')
    expect(state.mapping.nodes[52]).toMatchObject({ hidden: true })
    expect(Object.keys(state.cache.boards.A7!.axes)).toEqual(['0', '2']) // merged, axis 2 kept

    // The backup holds the setup from before the import.
    const backups = readdirSync(join(dir, 'backups'))
    expect(backups).toEqual(['skyhawk-config-2026-10-16T10-00-00-000Z.json'])
    const backup = JSON.parse(readFileSync(join(dir, 'backups', backups[0]!), 'utf8'))
    expect(backup.sections.powerSupply.mode).toBe('preset')
    expect(r.ok && r.backupPath).toBe(join(dir, 'backups', backups[0]!))

    expect(t.apply(p.token, ['app'], false)).toMatchObject({ ok: false }) // applied once only
  })

  it('a node mapping that cannot be saved stops the whole import', () => {
    const t = transfer()
    const p = ready(t.preview(otherSetupFile(), '/x/a.json'))
    state.mappingRefuses = 'Not saved: node-mapping.json was written by a newer client'
    expect(t.apply(p.token, ['app', 'nodeMapping', 'calibration'], false)).toEqual({
      ok: false,
      error:
        'Nothing was changed — Node mapping could not be saved: Not saved: node-mapping.json was ' +
        'written by a newer client'
    })
    expect(state.calls).toEqual([])
  })

  it('refuses a malformed request from the renderer', () => {
    const t = transfer()
    const p = ready(t.preview(otherSetupFile(), '/x/a.json'))
    for (const [sections, backup] of [
      ['app', false],
      [['app', 'macros'], false],
      [['app'], 'yes'],
      [[], false]
    ] as const) {
      expect(t.apply(p.token, sections, backup)).toMatchObject({ ok: false })
    }
    expect(t.apply('other-token', ['app'], false)).toMatchObject({ ok: false })
    expect(state.calls).toEqual([])
  })
})

describe('ConfigTransfer: one import transaction (C2/M10)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skyhawk-transfer-'))
    state = {
      config: DEFAULT_CONFIG,
      mapping: { version: 3, nodes: { 1: { added: true, name: 'Armament' } } },
      cache: {
        version: 1,
        boards: { A7: { confirmedAt: '2026-10-14T00:00:00Z', axes: { 2: axis(4, 5, 6) } } }
      },
      fail: {},
      writes: { mapping: 0, calibration: 0, config: 0 },
      calls: []
    }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const ALL = ['app', 'nodeMapping', 'powerSupply', 'calibration']
  /** The three stores as they stand, deep-copied. */
  const stores = () => structuredClone({ c: state.config, m: state.mapping, k: state.cache })

  const cases: { target: Target; error: string; calls: string[] }[] = [
    {
      target: 'mapping',
      error: 'Nothing was changed — Node mapping could not be saved: mapping write 1 failed',
      calls: []
    },
    {
      target: 'calibration',
      error:
        'Nothing was changed — Axis calibration could not be saved: calibration write 1 failed. ' +
        'Node mapping was put back as before',
      calls: ['mapping', 'mapping', 'restore mapping']
    },
    {
      target: 'config',
      error:
        'Nothing was changed — App settings and Power supply could not be saved: config write 1 ' +
        'failed. Node mapping and Axis calibration were put back as before',
      calls: ['mapping', 'calibration', 'restore calibration', 'mapping', 'restore mapping']
    }
  ]
  for (const c of cases) {
    it(`${c.target} fails: every target is as before the import, and the answer says so`, () => {
      const before = stores()
      const imported: string[] = []
      const tx = transfer({ imported: () => imported.push('imported') })
      const p2 = ready(tx.preview(otherSetupFile(), '/x/a.json'))
      state.fail[c.target] = [1]
      const r = tx.apply(p2.token, ALL, false)
      expect(r).toEqual({ ok: false, error: c.error })
      expect(stores()).toEqual(before) // nothing half-applied
      // Written, then put back newest first: the store's own write, then its bytes (and .bak).
      expect(state.calls).toEqual(c.calls)
      expect(imported).toEqual([]) // the renderer is not told of an import that did not land
      // The file stays open: the same import can be tried again, and lands whole.
      state.fail = {}
      expect(tx.apply(p2.token, ALL, false)).toMatchObject({ ok: true, applied: ALL })
      expect(state.config.host).toBe('10.0.0.2')
      expect(state.mapping.nodes[52]).toMatchObject({ name: 'Trim' })
      expect(Object.keys(state.cache.boards.A7!.axes)).toEqual(['0', '2'])
      expect(imported).toEqual(['imported'])
    })
  }

  it('the settings target names the sections it holds', () => {
    const t = transfer()
    const p = ready(t.preview(otherSetupFile(), '/x/a.json'))
    state.fail.config = [1]
    expect(t.apply(p.token, ['powerSupply', 'nodeMapping'], false)).toEqual({
      ok: false,
      error:
        'Nothing was changed — Power supply could not be saved: config write 1 failed. Node ' +
        'mapping was put back as before'
    })
    expect(state.config).toEqual(DEFAULT_CONFIG)
  })

  it('a rollback that fails too: the answer says the import is only partly applied, and where', () => {
    const t = transfer()
    const p = ready(t.preview(otherSetupFile(), '/x/a.json'))
    const before = stores()
    state.fail = { config: [1], mapping: [2] } // config fails, then putting the mapping back does
    const r = t.apply(p.token, ALL, true)
    expect(r).toEqual({
      ok: false,
      error:
        'The import is only partly applied — App settings and Power supply could not be saved: ' +
        'config write 1 failed. Node mapping could not be put back (mapping write 2 failed), so ' +
        'it keeps the imported settings. Axis calibration was put back as before. Your previous ' +
        'setup is in skyhawk-config-2026-10-16T10-00-00-000Z.json.'
    })
    expect(state.mapping).not.toEqual(before.m) // honestly reported: still the file's
    expect(state.cache).toEqual(before.k)
    expect(state.config).toEqual(before.c)
  })

  it('a byte copy that cannot be put back: the answer says the import is only partly applied', () => {
    const t = transfer()
    const p = ready(t.preview(otherSetupFile(), '/x/a.json'))
    state.fail = { config: [1] }
    state.copyFails = { calibration: 'restore' }
    expect(t.apply(p.token, ALL, false)).toEqual({
      ok: false,
      error:
        'The import is only partly applied — App settings and Power supply could not be saved: ' +
        'config write 1 failed. Axis calibration could not be put back (calibration could not be ' +
        'put back: EROFS), so it keeps the imported settings. Node mapping was put back as before.'
    })
  })

  it('a target whose file cannot be copied for a rollback stops the import before any write', () => {
    const t = transfer()
    const p = ready(t.preview(otherSetupFile(), '/x/a.json'))
    const before = stores()
    state.copyFails = { config: 'snapshot' }
    expect(t.apply(p.token, ALL, true)).toEqual({
      ok: false,
      error:
        'Nothing was changed — App settings and Power supply could not be copied for a ' +
        'rollback: config unreadable'
    })
    expect(state.calls).toEqual([])
    expect(stores()).toEqual(before)
    expect(() => readdirSync(join(dir, 'backups'))).toThrow() // no backup written either
  })

  it('a backup that fails stops the import before anything is written', () => {
    const t = transfer({ backupDir: () => join(dir, 'file') })
    writeFileSync(join(dir, 'file'), 'not a folder')
    const p = ready(t.preview(otherSetupFile(), '/x/a.json'))
    expect(t.apply(p.token, ALL, true)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^Backup failed, nothing was changed: /)
    })
    expect(state.calls).toEqual([])
  })
})
