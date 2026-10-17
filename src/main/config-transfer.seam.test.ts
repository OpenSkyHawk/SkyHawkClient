// XFER-seam contract test (Phase 0, row B94): how ConfigTransfer reads an import file's sections —
// open → preview → apply — with the four stores held in memory.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_FORMAT, DEFAULT_CONFIG, type AppConfig } from '@shared/config/ipc'
import { registryDefaults } from '@shared/node-mapping'
import type { NodeMappingFile } from '@shared/nodes/ipc'
import type { CalCache } from '@shared/hid/calibration/ipc'
import { ConfigTransfer } from './config-transfer'

const axis = (min: number, centre: number, max: number) => ({
  min,
  centre,
  max,
  selfCentring: true
})

let dir: string
let stores: { config: AppConfig; mapping: NodeMappingFile; cache: CalCache }

function transfer() {
  return new ConfigTransfer({
    getConfig: () => stores.config,
    setConfig: (c) => (stores.config = c),
    nodes: {
      mappingFile: () => stores.mapping,
      registryDefaults: () =>
        registryDefaults({
          1: { name: 'Center_Armament', console: 'Center' },
          2: { name: 'Right_Navigation', console: 'Right' },
          4: { name: 'PDU_Right', console: 'Right' }
        }),
      onlineIds: () => [],
      importMapping: (f) => {
        stores.mapping = f
        return { ok: true, model: {} as never }
      }
    },
    loadCalCache: () => stores.cache,
    saveCalCache: (c) => (stores.cache = c),
    backupDir: () => join(dir, 'backups'),
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

  it('a section that is not an object, or that this client does not know, is skipped', () => {
    const t = transfer()
    const opened = t.preview(
      file({
        app: 'not an object',
        nodeMapping: [1, 2],
        macros: { x: 1 },
        powerSupply: { mode: 'custom', custom: { a12: 40 } }
      }),
      '/x/a.json'
    )
    expect(opened.status).toBe('ready')
    if (opened.status !== 'ready') return
    expect(opened.preview.skipped).toEqual(['app', 'nodeMapping', 'macros'])
    expect(opened.preview.sections.map((s) => s.id)).toEqual(['powerSupply'])

    // A skipped section can't be applied; the readable one can.
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
      error: 'This file has no settings this client can read.'
    })
    expect(t.apply('any', ['macros'], false)).toMatchObject({ ok: false })
    expect(stores.config).toBe(DEFAULT_CONFIG)
  })

  it("every known section goes through its own store's tolerant sanitizer: bad fields are dropped", () => {
    const t = transfer()
    const opened = t.preview(
      file({
        app: {
          host: '',
          commandPort: 'x',
          sourceMode: 'nonsense',
          debugMode: true,
          psu: { mode: 'custom' }
        },
        nodeMapping: {
          version: 3,
          nodes: { 99: { name: 'out of range' }, 2: { name: 'Nav', pduId: 'x' } }
        },
        powerSupply: { mode: 'custom', preset: 'no-such-psu', custom: { a12: 40, a5: 'x' } },
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
    const r = t.apply(
      opened.preview.token,
      ['app', 'nodeMapping', 'powerSupply', 'calibration'],
      false
    )
    expect(r).toMatchObject({ ok: true })

    // app: junk fields fall back to their defaults, the good one is kept, its psu is ignored.
    expect(stores.config).toEqual({
      ...DEFAULT_CONFIG,
      debugMode: true,
      psu: { mode: 'custom', preset: 'nx650', custom: { a12: 40 } }
    })
    // nodeMapping: an out-of-range NODE_ID and a bad power zone are dropped.
    expect(stores.mapping).toEqual({ version: 3, nodes: { 2: { name: 'Nav' } } })
    // calibration: an axis that is not min < centre < max is dropped.
    expect(Object.keys(stores.cache.boards.A7!.axes)).toEqual(['0'])
  })
})
