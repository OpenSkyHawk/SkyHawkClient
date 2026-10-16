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

  it('adopting a new node takes it out of "new"; a nameless adopt is refused and changes nothing', () => {
    const { h, roster } = hub()
    roster.applyMessage(NODE_MSG, '29010000000000000080000000', 0) // node 41 reports
    h.flush(roster.takeDirty(), 0)
    const node41 = () => h.snapshot(0).model.nodes.find((n) => n.nodeId === 41)
    expect(node41()?.source).toBe('new')

    const nameless = { console: 'Left', pduId: 3, kind: 'panel' } as never
    expect(h.adopt(41, nameless)).toEqual({ ok: false, error: 'Name cannot be empty' })
    expect(node41()?.source).toBe('new')
    expect(disk.saves).toBe(0)

    const ok = h.adopt(41, { name: 'Left_Trim', console: 'Left', pduId: 3, kind: 'panel' })
    expect(ok.ok).toBe(true)
    expect(node41()).toMatchObject({ source: 'adopted', name: 'Left_Trim', pduId: 3 })
  })

  it('a board hidden while still listed stays hidden until it actually comes back', () => {
    const { h, roster } = hub()
    const node2 = (present: boolean) =>
      present ? '02010000000000000080000000' : '02000000000000000080000000'
    roster.applyMessage(NODE_MSG, node2(true), 0)
    h.flush(roster.takeDirty(), 0)
    expect(h.hide(2, true).ok).toBe(true) // still listed (bridge has not timed it out)

    roster.applyMessage(NODE_MSG, '01010000000000000080000000', 100) // another node's delta
    h.flush(roster.takeDirty(), 100)
    roster.beginBurst(5000) // poll reply still lists node 2
    roster.applyMessage(NODE_MSG, node2(true), 5000)
    roster.applyMessage(NODE_END_MSG, '2', 5000)
    h.flush(roster.takeDirty(), 5000)
    expect(disk.file.nodes[2]).toEqual({ hidden: true })

    roster.applyMessage(NODE_MSG, node2(false), 6000) // timed out
    h.flush(roster.takeDirty(), 6000)
    expect(disk.file.nodes[2]).toEqual({ hidden: true })

    roster.applyMessage(NODE_MSG, node2(true), 9000) // board is back
    h.flush(roster.takeDirty(), 9000)
    expect(disk.file.nodes[2]).toBeUndefined()
  })

  it('hiding a new node is refused and writes nothing', () => {
    const { h } = hub()
    expect(h.hide(41, true)).toEqual({
      ok: false,
      error: 'Only a registry or adopted node can be hidden — ignore a new node instead'
    })
    expect(disk.saves).toBe(0)
    expect(h.hide(2, true).ok).toBe(true)
  })

  it('a non-boolean on/off is refused; a no-op change writes and pushes nothing', () => {
    const { h, pushes } = hub()
    expect(h.ignore(5, 'no' as never)).toEqual({ ok: false, error: 'Invalid on/off value' })
    expect(h.forget(NaN)).toEqual({ ok: false, error: 'Not a NODE_ID: NaN' })
    const forgot = h.forget(41) // nothing mapped
    expect(forgot.ok).toBe(true)
    expect(disk.saves).toBe(0)
    expect(pushes).toEqual([])
  })

  it('malformed renderer input resolves to { ok: false } instead of throwing', () => {
    const { h } = hub()
    expect(h.setMapping(1, null as never)).toEqual({ ok: false, error: 'Invalid mapping change' })
    expect(h.adopt(41, 'x' as never)).toEqual({ ok: false, error: 'Invalid adopt request' })
    expect(disk.saves).toBe(0)
  })

  it('ignoring records when and what the node reported as; un-ignoring forgets it', () => {
    const { h, roster } = hub()
    roster.applyMessage(NODE_MSG, '2F010000000000000080000000', 0) // node 47 reports
    h.telemetry('2F0100E02E182EBC02', 0) // ... and sends PDU pages
    expect(h.ignore(47, true, 1000).ok).toBe(true)
    expect(disk.file.ignoredMeta).toEqual({ 47: { at: '1970-01-01T00:00:01.000Z', kind: 'pdu' } })
    expect(h.snapshot().model.ignoredNodes).toMatchObject([{ nodeId: 47, kind: 'pdu' }])
    h.ignore(47, false)
    expect(disk.file).toEqual({ version: 1, nodes: {}, ignored: [] })
  })

  it('stores a kind only when known, so an early-ignored PDU is not kept as a panel', () => {
    const { h, roster } = hub()
    roster.applyMessage(NODE_MSG, '2F010000000000000080000000', 0) // node 47: status only
    h.ignore(47, true, 1000)
    expect(disk.file.ignoredMeta?.[47]).toEqual({ at: '1970-01-01T00:00:01.000Z' }) // no guess
    expect(h.snapshot(1000).model.ignoredNodes[0]).not.toHaveProperty('kind')
    h.telemetry('2F0100E02E182EBC02', 2000) // ... then its first PDU page
    expect(h.snapshot(2000).model.ignoredNodes[0]?.kind).toBe('pdu')

    h.ignore(3, true, 3000) // registry PDU, never reported
    h.adopt(41, { name: 'Trim', console: 'Left', pduId: null, kind: 'panel' })
    h.ignore(41, true, 3000) // adopted panel
    expect(disk.file.ignoredMeta?.[3]?.kind).toBe('pdu')
    expect(disk.file.ignoredMeta?.[41]?.kind).toBe('panel')
  })

  it('reset can also forget adopted nodes, and previews what it changes', () => {
    const { h } = hub()
    h.setMapping(1, { name: 'Armament' })
    h.adopt(41, { name: 'Trim', console: 'Left', pduId: null, kind: 'panel' })
    expect(h.previewReset()).toMatchObject({ nodeCount: 1, adopted: [{ nodeId: 41 }] })
    expect(h.resetAll().ok).toBe(true)
    expect(Object.keys(disk.file.nodes)).toEqual(['41'])
    expect(h.resetAll({ forgetAdopted: true }).ok).toBe(true)
    expect(disk.file.nodes).toEqual({})
    expect(h.resetAll(null as never)).toEqual({ ok: false, error: 'Invalid reset request' })
  })

  it('serves the bundled registry with PanelBridge and its source commit', () => {
    const r = hub().h.registry()
    expect(r.nodes[0]).toEqual({ nodeId: 0, name: 'PanelBridge', console: '—', kind: 'bridge' })
    expect(r.nodes.find((n) => n.nodeId === 3)?.kind).toBe('pdu')
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('accepts a telemetry line with padding or a trailing CR (Windows-style ending)', () => {
    const { h } = hub()
    h.telemetry(' 030100E02E182EBC02\r', 0)
    expect(h.snapshot(0).telemetry[0]?.rail12V).toMatchObject({ vAvgMv: 12000, iAvgMa: 700 })
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
