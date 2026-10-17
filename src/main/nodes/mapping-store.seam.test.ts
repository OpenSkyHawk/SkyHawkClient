// FILE-seam contract test (Phase 0, row B17): node-mapping.json as it is read from and written to
// <userData>. Older files are upgraded once, on read; the next save writes v4.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NodeMappingFile } from '@shared/nodes'
import { storeFiles, storePaths } from '../app/user-data'

const userData = vi.hoisted(() => ({ dir: '' }))
// <userData> is handed in the way app hands it in (the store no longer asks electron, P6), as the
// node-mapping.json port app wires (the JSON store under the file's policy).
const io = storeFiles(storePaths(() => userData.dir)).mappingFile

const store = await import('./mapping-file')
const loadNodeMapping = () => store.loadNodeMapping(io)
const saveNodeMapping = (f: NodeMappingFile) => store.saveNodeMapping(f, io)

const path = () => join(userData.dir, 'node-mapping.json')
const bak = () => `${path()}.bak`
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

  it('v2: a renamed registry board is in your cockpit; the save writes v4', () => {
    const { first, saved, second } = upgrade({ version: 2, nodes: { 2: { name: 'Nav' } } })
    expect(first).toEqual({ file: { version: 4, nodes: { 2: { name: 'Nav', added: true } } } })
    expect(saved).toEqual({ version: 4, nodes: { 2: { name: 'Nav', added: true } } })
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
    const v4 = {
      version: 4,
      nodes: {
        1: { lastSeen: T0, added: true },
        2: { console: 'Left', added: true },
        3: { name: 'PDU_L', added: true },
        4: { hidden: true, added: true },
        5: { pduId: null, added: true }
      }
    }
    expect(first).toEqual({ file: v4 })
    expect(saved).toEqual(v4)
  })

  it('no version at all reads as an old file; an adopted board keeps its own entry, marked', () => {
    const adopted = { name: 'Left_Trim', console: 'Left', kind: 'panel', pduId: 3 }
    const { first, saved } = upgrade({
      nodes: { 2: { name: 'Nav' }, 41: adopted, 5: { bogus: true } }
    })
    // Registry board 5 had nothing worth keeping: it is dropped, not added. The adopted board
    // carries v4's one marker (S1).
    const v4 = {
      version: 4,
      nodes: { 2: { name: 'Nav', added: true }, 41: { ...adopted, added: true } }
    }
    expect(first).toEqual({ file: v4 })
    expect(saved).toEqual(v4)
  })

  it('once upgraded the file is read as written: a v3 entry without `added` stays out', () => {
    upgrade({ version: 2, nodes: { 2: { name: 'Nav' } } })
    write({ version: 3, nodes: { 2: { name: 'Nav', added: true }, 1: { name: 'Arm' } } })
    expect(loadNodeMapping().file.nodes).toEqual({
      2: { name: 'Nav', added: true },
      1: { name: 'Arm' }
    })
  })

  it('v3: every field is kept, an adopted board is marked, and the v3 file becomes the .bak', () => {
    const v3 = {
      version: 3,
      nodes: {
        1: { added: true, name: 'Arm', console: 'Left', pduId: null, hidden: true, lastSeen: T0 },
        2: { name: 'Nav' },
        41: { name: 'Left_Trim', console: 'Left', kind: 'panel', pduId: 3, lastSeen: T0 }
      }
    }
    const { first, saved, second } = upgrade(v3)
    const v4 = { version: 4, nodes: { ...v3.nodes, 41: { ...v3.nodes[41], added: true } } }
    expect(first).toEqual({ file: v4 })
    expect(saved).toEqual(v4)
    expect(second).toEqual(first)
    expect(JSON.parse(readFileSync(bak(), 'utf8'))).toEqual(v3) // the save before it, kept
  })

  it('a damaged v4 file falls back to its v3 .bak, upgraded the same way', () => {
    upgrade({ version: 3, nodes: { 41: { name: 'Trim', console: 'Left', kind: 'panel' } } })
    writeFileSync(path(), '{"version":4,"nodes":{"41":{"na')
    const loaded = loadNodeMapping()
    expect(loaded.file).toEqual({
      version: 4,
      nodes: { 41: { name: 'Trim', console: 'Left', kind: 'panel', added: true } }
    })
    expect(loaded.readOnly).toBeUndefined()
    expect(loaded.notice?.severity).toBe('warn')
  })

  it('a file newer than v4 is loaded read-only and never rewritten', () => {
    const v5 = { version: 5, nodes: { 2: { added: true, name: 'Nav', future: 1 } } }
    write(v5)
    const before = readFileSync(path(), 'utf8')
    const loaded = loadNodeMapping()
    expect(loaded.readOnly).toBe('node-mapping.json was written by a newer client')
    expect(loaded.file.nodes).toEqual({ 2: { added: true, name: 'Nav' } })
    expect(readFileSync(path(), 'utf8')).toBe(before)
  })
})
