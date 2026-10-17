import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type AppConfig, type ImportPreview } from '@shared/config'
import { registryDefaults } from '../nodes/registry'
import type { NodeMappingFile } from '@shared/nodes'
import type { CalCache } from '@shared/hid/calibration'
import { ConfigTransfer } from './config-transfer'

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
let state: {
  config: AppConfig
  mapping: NodeMappingFile
  cache: CalCache
  mappingRefuses?: string
  calls: string[]
}

function transfer() {
  return new ConfigTransfer({
    getConfig: () => state.config,
    setConfig: (c) => {
      state.calls.push('config')
      return (state.config = c)
    },
    nodes: {
      mappingFile: () => state.mapping,
      registryDefaults: () => defaults,
      onlineIds: () => [],
      importMapping: (f) => {
        if (state.mappingRefuses) return { ok: false, error: state.mappingRefuses }
        state.calls.push('mapping')
        state.mapping = f
        return { ok: true, model: {} as never }
      }
    },
    loadCalCache: () => state.cache,
    saveCalCache: (c) => {
      state.calls.push('calibration')
      state.cache = c
    },
    backupDir: () => join(dir, 'backups'),
    clientVersion: () => '0.2.0',
    now: () => new Date('2026-10-16T10:00:00Z')
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
    mapping: { version: 3, nodes: { 1: { name: 'Arm' }, 52: { hidden: true } } },
    cache: {
      version: 1,
      boards: { A7: { confirmedAt: '2026-10-12T00:00:00Z', axes: { 0: axis(1, 2, 3) } } }
    },
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
      error: 'Nothing was changed: Not saved: node-mapping.json was written by a newer client'
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
