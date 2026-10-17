// XFER-seam contract test (Phase 0, row B94): how ConfigTransfer reads an import file's sections —
// open → preview → apply — with the four stores held in memory. Since C1 each known section is
// read strictly: without its structural markers it is rejected (listed with its reason), never
// read as an empty or default setting; inside a complete collection the entries are still read
// by the store's tolerant sanitizer.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_FORMAT, DEFAULT_CONFIG, type AppConfig } from '@shared/config'
import { registryDefaults } from '../nodes/registry'
import type { NodeMappingFile } from '@shared/nodes'
import type { CalCache } from '@shared/hid/calibration'
import { BackupFolder } from './backup-folder'
import { ConfigTransfer } from './config-transfer'

const axis = (min: number, centre: number, max: number) => ({
  min,
  centre,
  max,
  selfCentring: true
})

let dir: string
let stores: { config: AppConfig; mapping: NodeMappingFile; cache: CalCache }

/** No rollback happens here: the file copies are never put back. */
const noCopy = { snapshot: () => ({ file: null, bak: null }), restore: () => undefined }

function transfer() {
  return new ConfigTransfer({
    getConfig: () => stores.config,
    replaceConfig: (c) => ({ ok: true, config: (stores.config = c) }),
    nodes: {
      mappingFile: () => stores.mapping,
      registryDefaults: () =>
        registryDefaults({
          1: { name: 'Center_Armament', console: 'Center' },
          2: { name: 'Right_Navigation', console: 'Right' },
          4: { name: 'PDU_Right', console: 'Right' }
        }),
      onlineIds: () => [],
      replaceMapping: (f) => {
        stores.mapping = f
        return { ok: true, model: {} as never }
      }
    },
    loadCalCache: () => stores.cache,
    saveCalCache: (c) => {
      stores.cache = c
      return undefined
    },
    files: { mapping: noCopy, calibration: noCopy, config: noCopy },
    backups: new BackupFolder({ dir: () => join(dir, 'backups') }),
    clientVersion: () => '0.2.0',
    now: () => new Date('2026-10-16T10:00:00Z')
  })
}

const file = (sections: unknown) =>
  JSON.stringify({
    format: CONFIG_FORMAT,
    version: 1,
    exportedAt: '2026-10-16T09:00:00Z',
    sections
  })

describe('B94 an import reads each section on its own', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skyhawk-xfer-seam-'))
    stores = {
      config: DEFAULT_CONFIG,
      mapping: { version: 3, nodes: {} },
      cache: { version: 1, boards: {} }
    }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a broken known section is rejected with its reason; an unknown one is skipped', () => {
    const t = transfer()
    const opened = t.preview(
      file({
        app: 'not an object',
        nodeMapping: [1, 2],
        macros: { x: 1 },
        powerSupply: { mode: 'custom', preset: 'nx650', custom: { a12: 40 } }
      }),
      '/x/a.json'
    )
    expect(opened.status).toBe('ready')
    if (opened.status !== 'ready') return
    expect(opened.preview.skipped).toEqual(['macros'])
    expect(opened.preview.rejected).toEqual([
      { id: 'app', title: 'App settings', reason: 'it is not a settings section' },
      { id: 'nodeMapping', title: 'Node mapping', reason: 'it is not a settings section' }
    ])
    expect(opened.preview.sections.map((s) => s.id)).toEqual(['powerSupply'])

    // A rejected section can't be applied; the readable one can.
    expect(t.apply(opened.preview.token, ['app'], false)).toEqual({
      ok: false,
      error: 'No sections picked'
    })
    expect(t.apply(opened.preview.token, ['app', 'powerSupply'], false)).toMatchObject({
      ok: true,
      applied: ['powerSupply']
    })
    expect(stores.config.psu).toEqual({ mode: 'custom', preset: 'nx650', custom: { a12: 40 } })
    expect(stores.config.host).toBe(DEFAULT_CONFIG.host)
  })

  it('a file with no section this client can read is refused, and nothing can be applied', () => {
    const t = transfer()
    expect(t.preview(file({ app: null, macros: { x: 1 } }), '/x/a.json')).toEqual({
      status: 'error',
      error:
        'This file has no settings this client can read. App settings: it is not a settings section.'
    })
    expect(t.apply('any', ['macros'], false)).toMatchObject({ ok: false })
    expect(stores.config).toBe(DEFAULT_CONFIG)
  })

  it('"nodeMapping": {} and "app": {} are rejected, so adopted boards and settings stay (C1)', () => {
    stores.mapping = {
      version: 3,
      nodes: {
        41: { name: 'Trim', console: 'Left', pduId: null, kind: 'panel' },
        1: { added: true }
      }
    }
    stores.config = { ...DEFAULT_CONFIG, host: '10.0.0.9' }
    const before = structuredClone(stores)
    const t = transfer()
    const opened = t.preview(
      file({ nodeMapping: {}, app: {}, powerSupply: DEFAULT_CONFIG.psu }),
      '/x/a.json'
    )
    if (opened.status !== 'ready') throw new Error(JSON.stringify(opened))
    expect(opened.preview.rejected.map((r) => `${r.title}: ${r.reason}`)).toEqual([
      'Node mapping: it has no version',
      'App settings: it has no “Source mode” setting'
    ])
    expect(opened.preview.identical).toBe(true) // the readable section changes nothing
    expect(t.apply(opened.preview.token, ['nodeMapping', 'app'], false)).toEqual({
      ok: false,
      error: 'No sections picked'
    })
    expect(stores).toEqual(before)
  })

  it('inside complete sections, the stores’ tolerant sanitizers still drop bad entries', () => {
    const t = transfer()
    const opened = t.preview(
      file({
        nodeMapping: {
          version: 3,
          nodes: { 99: { name: 'out of range' }, 2: { name: 'Nav', pduId: 'x' } }
        },
        calibration: {
          version: 1,
          boards: {
            A7: {
              confirmedAt: '2026-10-12T00:00:00Z',
              axes: { 0: axis(1, 2, 3), 1: axis(5, 4, 3) }
            }
          }
        }
      }),
      '/x/a.json'
    )
    if (opened.status !== 'ready') throw new Error(JSON.stringify(opened))
    expect(opened.preview.skipped).toEqual([])
    expect(opened.preview.rejected).toEqual([])
    const r = t.apply(opened.preview.token, ['nodeMapping', 'calibration'], false)
    expect(r).toMatchObject({ ok: true })
    // nodeMapping: an out-of-range NODE_ID and a bad power zone are dropped.
    expect(stores.mapping).toEqual({ version: 3, nodes: { 2: { name: 'Nav' } } })
    // calibration: an axis that is not min < centre < max is dropped.
    expect(Object.keys(stores.cache.boards.A7!.axes)).toEqual(['0'])
  })
})
