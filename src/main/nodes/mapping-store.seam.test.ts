// FILE-seam contract test (Phase 0, row B17): node-mapping.json as it is read from and written to
// <userData>. Older files are upgraded once, on read; the next save writes v3.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NodeMappingFile } from '@shared/nodes'
import { storePaths } from '../app/user-data'

const userData = vi.hoisted(() => ({ dir: '' }))
// <userData> is handed in the way app hands it in (the store no longer asks electron, P6).
const paths = storePaths(() => userData.dir)

const store = await import('./mapping-store')
const loadNodeMapping = () => store.loadNodeMapping(paths)
const saveNodeMapping = (f: NodeMappingFile) => store.saveNodeMapping(f, paths)

const path = () => join(userData.dir, 'node-mapping.json')
const write = (raw: unknown) => writeFileSync(path(), JSON.stringify(raw))
const onDisk = () => JSON.parse(readFileSync(path(), 'utf8')) as unknown
const T0 = '2026-10-14T21:14:00.000Z'

/** Load, save what was loaded, and load again: what an upgrade leaves behind. */
function upgrade(raw: unknown) {
  write(raw)
  const first = loadNodeMapping()
  saveNodeMapping(first.file)
  return { first, saved: onDisk(), second: loadNodeMapping() }
}

describe('B17 older node-mapping.json files are upgraded once, on read', () => {
  beforeEach(() => {
    userData.dir = mkdtempSync(join(tmpdir(), 'skyhawk-mapping-seam-'))
  })
  afterEach(() => rmSync(userData.dir, { recursive: true, force: true }))

  it('v2: a renamed registry board is in your cockpit; the save writes v3', () => {
    const { first, saved, second } = upgrade({ version: 2, nodes: { 2: { name: 'Nav' } } })
    expect(first).toEqual({ file: { version: 3, nodes: { 2: { name: 'Nav', added: true } } } })
    expect(saved).toEqual({ version: 3, nodes: { 2: { name: 'Nav', added: true } } })
    expect(second).toEqual(first)
  })

  it('v1: the ignore list is dropped; seen, placed, renamed and hidden boards are added', () => {
    const { first, saved } = upgrade({
      version: 1,
      ignored: [50, 51],
      nodes: {
        1: { lastSeen: T0 }, // seen
        2: { console: 'Left' }, // placed
        3: { name: 'PDU_L' }, // renamed
        4: { hidden: true }, // hidden
        5: { pduId: null } // power zone set to none: placed
      }
    })
    const v3 = {
      version: 3,
      nodes: {
        1: { lastSeen: T0, added: true },
        2: { console: 'Left', added: true },
        3: { name: 'PDU_L', added: true },
        4: { hidden: true, added: true },
        5: { pduId: null, added: true }
      }
    }
    expect(first).toEqual({ file: v3 })
    expect(saved).toEqual(v3)
  })

  it('no version at all reads as an old file; an adopted board keeps its own entry, not added', () => {
    const adopted = { name: 'Left_Trim', console: 'Left', kind: 'panel', pduId: 3 }
    const { first, saved } = upgrade({
      nodes: { 2: { name: 'Nav' }, 41: adopted, 5: { bogus: true } }
    })
    // Registry board 5 had nothing worth keeping: it is dropped, not added.
    const v3 = { version: 3, nodes: { 2: { name: 'Nav', added: true }, 41: adopted } }
    expect(first).toEqual({ file: v3 })
    expect(saved).toEqual(v3)
  })

  it('once upgraded the file is read as written: a v3 entry without `added` stays out', () => {
    upgrade({ version: 2, nodes: { 2: { name: 'Nav' } } })
    write({ version: 3, nodes: { 2: { name: 'Nav', added: true }, 1: { name: 'Arm' } } })
    expect(loadNodeMapping().file.nodes).toEqual({
      2: { name: 'Nav', added: true },
      1: { name: 'Arm' }
    })
  })
})
