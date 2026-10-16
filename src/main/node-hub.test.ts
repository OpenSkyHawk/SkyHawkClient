import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeMappingFile } from '@shared/node-mapping'
import { NODE_END_MSG, NODE_MSG, NodeRoster } from '@shared/nodes'

const disk: {
  file: NodeMappingFile
  saves: number
  readOnly?: string
  fail?: boolean
} = {
  file: { version: 1, nodes: {}, ignored: [] },
  saves: 0
}
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } })) // debug log path
vi.mock('./node-mapping', () => {
  class MappingSaveError extends Error {}
  return {
    MappingSaveError,
    loadNodeMapping: () => ({ file: disk.file, readOnly: disk.readOnly }),
    saveNodeMapping: (f: NodeMappingFile) => {
      if (disk.fail) throw new MappingSaveError('Could not save node mapping: EROFS')
      disk.file = f
      disk.saves++
    }
  }
})

const { NodeHub } = await import('./node-hub')

function hub() {
  const pushes: [string, unknown][] = []
  const roster = new NodeRoster()
  const h = new NodeHub((c, p) => pushes.push([c, p]), roster)
  return { h, roster, pushes }
}

describe('NodeHub', () => {
  beforeEach(() => {
    disk.file = { version: 1, nodes: {}, ignored: [] }
    disk.saves = 0
    disk.readOnly = undefined
    disk.fail = false
  })

  it('a failed save is reported, and the change is not applied', () => {
    const { h, pushes } = hub()
    disk.fail = true
    expect(h.setMapping(1, { name: 'Armament' })).toEqual({
      ok: false,
      error: 'Could not save node mapping: EROFS'
    })
    expect(h.snapshot().model.nodes.find((n) => n.nodeId === 1)?.name).toBe('Center_Armament')
    expect(pushes.filter(([c]) => c === 'nodes:model')).toEqual([])
  })

  it('a read-only mapping (newer client, unreadable) refuses every save', () => {
    disk.readOnly = 'node-mapping.json was written by a newer client'
    const { h } = hub()
    expect(h.ignore(41, true)).toEqual({
      ok: false,
      error: 'Not saved: node-mapping.json was written by a newer client'
    })
    expect(disk.saves).toBe(0)
  })

  it('a reporting board is un-hidden even when that save fails', () => {
    disk.file = { version: 1, nodes: { 2: { hidden: true } }, ignored: [] }
    disk.fail = true
    const { h, roster } = hub()
    roster.applyMessage(NODE_MSG, '02010000000000000080000000', 0)
    h.flush(roster.takeDirty(), 0)
    expect(h.snapshot(0).model.hidden).toEqual([])
    expect(disk.file.nodes).toEqual({ 2: { hidden: true } }) // not on disk
  })

  it('clears "hidden until it reports again" once the node reports, and saves it', () => {
    disk.file = { version: 1, nodes: { 2: { hidden: true } }, ignored: [] }
    const { h, roster } = hub()
    roster.applyMessage(NODE_MSG, '01010000000000000080000000', 0) // node 1 present
    roster.applyMessage(NODE_END_MSG, '1', 0)
    h.flush(roster.takeDirty(), 0)
    expect(disk.saves).toBe(0)
    expect(h.snapshot(0).model.hidden).toEqual([2]) // skipped, not offline

    roster.applyMessage(NODE_MSG, '02010000000000000080000000', 100) // node 2 reports
    h.flush(roster.takeDirty(), 100)
    expect(disk.file.nodes).toEqual({})
    expect(disk.saves).toBe(1)
    expect(h.snapshot(100).model.nodes.find((n) => n.nodeId === 2)?.availability).toBe('online')
  })

  it('a mapping change persists and pushes the new model; bad input writes nothing', () => {
    const { h, pushes } = hub()
    const ok = h.setMapping(1, { name: 'Armament' })
    expect(ok.ok && ok.model.nodes.find((n) => n.nodeId === 1)?.name).toBe('Armament')
    expect(disk.file.nodes).toEqual({ 1: { name: 'Armament' } })
    expect(pushes.at(-1)?.[0]).toBe('nodes:model')

    const before = disk.saves
    expect(h.setMapping(1, { name: ' ' })).toEqual({ ok: false, error: 'Name cannot be empty' })
    expect(h.adopt(1, { name: 'x', console: 'y', pduId: null, kind: 'panel' })).toMatchObject({
      ok: false
    })
    expect(disk.saves).toBe(before)
  })

  it('drops malformed telemetry and pushes nothing while idle', () => {
    const { h, pushes } = hub()
    h.flush(false, 0) // first tick: initial model
    pushes.length = 0
    h.telemetry('not hex', 10)
    h.flush(false, 2000)
    expect(pushes).toEqual([])
  })
})
