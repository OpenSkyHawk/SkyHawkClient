import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeMappingFile } from '@shared/node-mapping'
import { NODE_END_MSG, NODE_MSG, NodeRoster } from '@shared/nodes'

const disk: {
  file: NodeMappingFile
  saves: number
  readOnly?: string
  fail?: boolean
} = {
  file: { version: 3, nodes: {} },
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

const T0 = '1970-01-01T00:00:00.000Z'
/** The registry boards added to your cockpit (#93): the setup most tests assume. */
const added = (): NodeMappingFile => ({
  version: 3,
  nodes: {
    1: { added: true },
    2: { added: true },
    3: { added: true },
    4: { added: true },
    5: { added: true }
  }
})

function hub() {
  const pushes: [string, unknown][] = []
  const roster = new NodeRoster()
  const h = new NodeHub((c, p) => pushes.push([c, p]), roster)
  return { h, roster, pushes }
}

describe('NodeHub', () => {
  beforeEach(() => {
    disk.file = added()
    disk.saves = 0
    disk.readOnly = undefined
    disk.fail = false
  })

  it('a failed save is reported, and the change is not applied', () => {
    disk.file = { version: 3, nodes: { 1: { added: true, lastSeen: T0 } } }
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
    expect(h.hide(2, true)).toEqual({
      ok: false,
      error: 'Not saved: node-mapping.json was written by a newer client'
    })
    expect(disk.saves).toBe(0)
  })

  it('a reporting board is un-hidden even when that save fails', () => {
    disk.file = { version: 3, nodes: { 2: { hidden: true, added: true } } }
    disk.fail = true
    const { h, roster } = hub()
    roster.applyMessage(NODE_MSG, '0201000000000000008000000000', 0)
    h.flush(roster.takeDirty(), 0)
    expect(h.snapshot(0).model.hidden).toEqual([])
    expect(disk.file.nodes).toEqual({ 2: { hidden: true, added: true } }) // not on disk
  })

  it('clears "hidden until it reports again" once the node reports, and saves it', () => {
    disk.file = { version: 3, nodes: { 1: { added: true }, 2: { hidden: true, added: true } } }
    const { h, roster } = hub()
    roster.applyMessage(NODE_MSG, '0101000000000000008000000000', 0) // node 1 present
    roster.applyMessage(NODE_END_MSG, '1', 0)
    h.flush(roster.takeDirty(), 0)
    expect(disk.file.nodes).toEqual({
      1: { added: true, lastSeen: T0 },
      2: { hidden: true, added: true }
    })
    expect(h.snapshot(0).model.hidden).toEqual([2]) // skipped, not offline

    roster.applyMessage(NODE_MSG, '0201000000000000008000000000', 100) // node 2 reports
    h.flush(roster.takeDirty(), 100)
    expect(disk.file.nodes[2]).toEqual({ added: true, lastSeen: '1970-01-01T00:00:00.100Z' })
    expect(disk.saves).toBe(2)
    expect(h.snapshot(100).model.nodes.find((n) => n.nodeId === 2)?.availability).toBe('online')
  })

  it('last seen (#93): written when a board comes online, drops, and when the link closes', () => {
    const { h, roster } = hub()
    const row = (id: number, present: boolean) =>
      `0${id}${present ? '01' : '00'}000000000000008000000000`
    roster.applyMessage(NODE_MSG, row(1, true), 1000)
    roster.applyMessage(NODE_MSG, row(2, true), 1000)
    h.flush(roster.takeDirty(), 1000)
    expect([disk.file.nodes[1], disk.file.nodes[2]]).toEqual([
      { added: true, lastSeen: '1970-01-01T00:00:01.000Z' },
      { added: true, lastSeen: '1970-01-01T00:00:01.000Z' }
    ])
    const saves = disk.saves
    roster.applyMessage(NODE_MSG, row(1, true), 5000) // still there: no write
    h.flush(roster.takeDirty(), 5000)
    expect(disk.saves).toBe(saves)
    roster.applyMessage(NODE_MSG, row(2, false), 6000) // 2 drops
    h.flush(roster.takeDirty(), 6000)
    expect(disk.file.nodes[2]?.lastSeen).toBe('1970-01-01T00:00:06.000Z')
    h.linkClosed(9000) // unplug: 1 was still on the bus
    expect(disk.file.nodes[1]?.lastSeen).toBe('1970-01-01T00:00:09.000Z')
    expect(disk.file.nodes[2]?.lastSeen).toBe('1970-01-01T00:00:06.000Z')
    const after = disk.saves
    h.linkClosed(9500) // nothing on the bus any more: no write
    expect(disk.saves).toBe(after)
  })

  it('a board not in your cockpit is never written until added or adopted (#93)', () => {
    disk.file = { version: 3, nodes: {} }
    const { h, roster } = hub()
    roster.applyMessage(NODE_MSG, '2901000000000000008000000001', 0) // node 41
    roster.applyMessage(NODE_MSG, '0101000000000000008000000001', 0) // registry board 1
    h.flush(roster.takeDirty(), 0)
    expect(disk.saves).toBe(0)
    expect(h.snapshot(0).model.nodes.map((n) => [n.nodeId, n.source])).toEqual([
      [1, 'new'],
      [41, 'new']
    ])
    const spec = { name: 'Center_Armament', console: 'Center', pduId: 5, kind: 'panel' } as const
    expect(h.adopt(1, spec).ok).toBe(true) // Add to cockpit
    expect(disk.file.nodes[1]).toEqual({ added: true })
    expect(h.snapshot(0).model.nodes[0]).toMatchObject({ nodeId: 1, source: 'registry' })
  })

  it('a mapping change persists and pushes the new model; bad input writes nothing', () => {
    const { h, pushes } = hub()
    const ok = h.setMapping(1, { name: 'Armament' })
    expect(ok.ok && ok.model.nodes.find((n) => n.nodeId === 1)?.name).toBe('Armament')
    expect(disk.file.nodes[1]).toEqual({ added: true, name: 'Armament' })
    expect(pushes.at(-1)?.[0]).toBe('nodes:model')

    const before = disk.saves
    expect(h.setMapping(1, { name: ' ' })).toEqual({ ok: false, error: 'Name cannot be empty' })
    expect(h.adopt(1, { name: ' ', console: 'y', pduId: null, kind: 'panel' })).toMatchObject({
      ok: false
    })
    expect(disk.saves).toBe(before)
  })

  it('adopting a new node takes it out of "new"; a nameless adopt is refused and changes nothing', () => {
    const { h, roster } = hub()
    roster.applyMessage(NODE_MSG, '2901000000000000008000000000', 0) // node 41: kind not reported yet
    h.flush(roster.takeDirty(), 0)
    const node41 = () => h.snapshot(0).model.nodes.find((n) => n.nodeId === 41)
    expect(node41()?.source).toBe('new')
    // #344: nothing is adopted on a guess — not until it reports what it is.
    const spec = { name: 'Left_Trim', console: 'Left', pduId: 3, kind: 'panel' } as const
    expect(h.adopt(41, spec)).toEqual({ ok: false, error: 'Its board type is not known yet' })
    roster.applyMessage(NODE_MSG, '2901000000000000008000000001', 10) // ... then: panel group
    h.flush(roster.takeDirty(), 10)

    const nameless = { console: 'Left', pduId: 3, kind: 'panel' } as never
    expect(h.adopt(41, nameless)).toEqual({ ok: false, error: 'Name cannot be empty' })
    expect(node41()?.source).toBe('new')
    expect(disk.saves).toBe(0)

    expect(h.adopt(41, { ...spec, kind: 'pdu', pduId: null })).toEqual({
      ok: false,
      error: 'It reports as a panel group'
    })
    const ok = h.adopt(41, spec)
    expect(ok.ok).toBe(true)
    expect(node41()).toMatchObject({ source: 'adopted', name: 'Left_Trim', pduId: 3 })
  })

  it('Hide and Forget wait until a board is offline (#93): online, it is active on the bus', () => {
    const { h, roster } = hub()
    const node2 = (present: boolean) =>
      present ? '0201000000000000008000000000' : '0200000000000000008000000000'
    roster.applyMessage(NODE_MSG, node2(true), 0)
    h.flush(roster.takeDirty(), 0)
    const saves = disk.saves
    expect(h.hide(2, true)).toEqual({
      ok: false,
      error: 'It is online — a board on the bus can’t be hidden'
    })
    expect(h.forget(2)).toEqual({
      ok: false,
      error: 'It is online — a board on the bus can’t be forgotten'
    })
    expect(disk.saves).toBe(saves)

    roster.applyMessage(NODE_MSG, node2(false), 3000) // timed out
    h.flush(roster.takeDirty(), 3000)
    expect(h.hide(2, true).ok).toBe(true)
    roster.beginBurst(5000) // the poll reply still lists it, absent: stays hidden
    roster.applyMessage(NODE_MSG, node2(false), 5000)
    roster.applyMessage(NODE_END_MSG, '1', 5000)
    h.flush(roster.takeDirty(), 5000)
    expect(disk.file.nodes[2]?.hidden).toBe(true)

    roster.applyMessage(NODE_MSG, node2(true), 9000) // board is back
    h.flush(roster.takeDirty(), 9000)
    expect(disk.file.nodes[2]).toEqual({ added: true, lastSeen: '1970-01-01T00:00:09.000Z' })
  })

  it('hiding a new node is refused and writes nothing', () => {
    const { h } = hub()
    expect(h.hide(41, true)).toEqual({
      ok: false,
      error: 'Only a board in your cockpit can be hidden'
    })
    expect(disk.saves).toBe(0)
    expect(h.hide(2, true).ok).toBe(true)
  })

  it('forgetting an offline PDU (#93) unlinks the boards it fed; resetBoard restores a default', () => {
    disk.file = {
      version: 3,
      nodes: { 2: { added: true, lastSeen: T0, name: 'Nav' }, 4: { added: true, lastSeen: T0 } }
    }
    const { h } = hub()
    expect(h.forget(4).ok).toBe(true)
    expect(disk.file.nodes).toEqual({ 2: { added: true, lastSeen: T0, name: 'Nav', pduId: null } })
    expect(h.resetBoard(2).ok).toBe(true)
    expect(disk.file.nodes).toEqual({ 2: { added: true, lastSeen: T0 } }) // still in your cockpit
  })

  it('a non-boolean on/off is refused; a no-op change writes and pushes nothing', () => {
    const { h, pushes } = hub()
    expect(h.hide(5, 'no' as never)).toEqual({ ok: false, error: 'Invalid on/off value' })
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

  it('reset can also forget adopted nodes, and previews what it changes', () => {
    const { h, roster } = hub()
    roster.applyMessage(NODE_MSG, '2901000000000000008000000001', 0) // node 41: a panel group
    h.setMapping(1, { name: 'Armament' })
    h.adopt(41, { name: 'Trim', console: 'Left', pduId: null, kind: 'panel' })
    expect(h.previewReset()).toMatchObject({ nodeCount: 1, adopted: [{ nodeId: 41 }] })
    expect(h.resetAll().ok).toBe(true)
    expect(disk.file.nodes[1]).toEqual({ added: true }) // back to its defaults, still added
    expect(disk.file.nodes[41]).toBeDefined()
    expect(h.resetAll({ forgetAdopted: true }).ok).toBe(true)
    expect(disk.file.nodes).toEqual(added().nodes)
    expect(h.resetAll(null as never)).toEqual({ ok: false, error: 'Invalid reset request' })
  })

  it('a config import keeps what this computer observed: added and last seen (#93 review)', () => {
    disk.file = { version: 3, nodes: { 2: { added: true, lastSeen: T0, name: 'Nav' } } }
    const { h } = hub()
    expect(h.importMapping({ version: 3, nodes: { 2: { name: 'Nav_2' } } }).ok).toBe(true)
    expect(disk.file.nodes).toEqual({ 2: { name: 'Nav_2', added: true, lastSeen: T0 } })
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

describe('board kind (#344)', () => {
  beforeEach(() => {
    disk.file = added()
    disk.saves = 0
    disk.readOnly = undefined
    disk.fail = false
  })

  /** A v3 row: nodeId, present, kind; every other field idle. */
  const row = (id: number, kind: number, present = true) =>
    `${id.toString(16).padStart(2, '0')}${present ? '01' : '00'}0000000000000080000000${kind
      .toString(16)
      .padStart(2, '0')}`.toUpperCase()

  function withEvents() {
    const events: { event: string; nodeId?: number }[] = []
    const roster = new NodeRoster()
    const h = new NodeHub(
      () => {},
      roster,
      (e) => events.push(...e)
    )
    const status = (id: number, kind: number, t: number) => {
      roster.applyMessage(NODE_MSG, row(id, kind), t)
      h.statusLine(NODE_MSG, `_NODE_STATUS ${row(id, kind)}`, t)
    }
    return { h, roster, events, status }
  }

  const node = (h: InstanceType<typeof NodeHub>, id: number) =>
    h.snapshot(0).model.nodes.find((n) => n.nodeId === id)

  it('a board that reports PDU is one, whatever was stored: no power zone, and a zone for others', () => {
    // Adopted earlier as a panel group fed by PDU 3.
    disk.file = {
      version: 3,
      nodes: { 1: { added: true }, 41: { name: 'Aft', console: 'Left', kind: 'panel', pduId: 3 } }
    }
    const { h, roster } = hub()
    roster.applyMessage(NODE_MSG, row(41, 0x02), 0)
    expect(node(h, 41)).toMatchObject({ kind: 'pdu', identified: 'pdu', pduId: null })
    expect(h.setMapping(41, { pduId: 3 })).toEqual({ ok: false, error: 'A PDU has no power zone' })
    expect(h.setMapping(1, { pduId: 41 }).ok).toBe(true) // another panel can be fed by it
  })

  it('a registry panel ID that reports PDU is a PDU; a registry PDU that says nothing stays one', () => {
    disk.file = { version: 3, nodes: { 3: { added: true, lastSeen: T0 } } }
    const { h, roster } = hub()
    roster.applyMessage(NODE_MSG, row(2, 0x02), 0) // Right_Navigation's ID, on a PDU
    expect(node(h, 2)).toMatchObject({ kind: 'pdu', identified: 'pdu' })
    expect(node(h, 3)).toMatchObject({ kind: 'pdu', identified: 'pdu' }) // PDU_Left, no report
  })

  it('a bridge is never adoptable, and on the bus it can’t be hidden either (#93)', () => {
    const { h, roster } = hub()
    roster.applyMessage(NODE_MSG, row(41, 0x03), 0)
    const spec = { name: 'GW2', console: 'Left', pduId: null, kind: 'panel' } as const
    expect(h.adopt(41, spec)).toEqual({ ok: false, error: 'This board cannot be adopted' })
    expect(node(h, 41)).toMatchObject({ source: 'new', identified: 'bridge' })
    expect(h.hide(41, true)).toMatchObject({ ok: false })
    expect(disk.saves).toBe(0)
  })

  it('a registry board is added only once it says it is a PDU or a panel group (#93 re-review C, G)', () => {
    disk.file = { version: 3, nodes: {} }
    const { h, roster } = hub()
    const spec = { name: 'Center_Armament', console: 'Center', pduId: 5, kind: 'panel' } as const
    roster.applyMessage(NODE_MSG, row(1, 0x00), 0) // kind not reported yet
    expect(node(h, 1)?.identified).toBeUndefined()
    expect(h.adopt(1, spec)).toEqual({ ok: false, error: 'Its board type is not known yet' })
    roster.applyMessage(NODE_MSG, row(1, 0x03), 10) // a bridge on a registry panel's ID
    expect(h.adopt(1, spec)).toEqual({ ok: false, error: 'This board cannot be adopted' })
    roster.applyMessage(NODE_MSG, row(1, 0x01), 20) // a panel group
    expect(h.adopt(1, spec).ok).toBe(true)
    expect(disk.file.nodes[1]).toEqual({ added: true })
  })

  it('a kind this client does not know is not adoptable either', () => {
    const { h, roster } = hub()
    roster.applyMessage(NODE_MSG, row(41, 0x07), 0)
    expect(node(h, 41)?.identified).toBe('other')
    expect(h.adopt(41, { name: 'X', console: 'Left', pduId: null, kind: 'panel' })).toEqual({
      ok: false,
      error: 'This board cannot be adopted'
    })
  })

  it("the bridge's own row (node 0) is the link, never a cockpit node or an event", () => {
    const { h, events, status } = withEvents()
    status(0, 0x03, 0)
    expect(h.snapshot(0).model.nodes.some((n) => n.nodeId === 0)).toBe(false)
    expect(events.filter((e) => e.nodeId === 0)).toEqual([])
  })

  it('a node that appears after the baseline writes one row: "new on the bus" once identified', () => {
    const { h, roster, events, status } = withEvents()
    status(1, 0x01, 0)
    roster.applyMessage(NODE_END_MSG, '1', 0)
    h.statusLine(NODE_END_MSG, '_NODE_STATUS_END 1', 0) // baseline closed
    status(41, 0x00, 2000) // first sight, kind not reported yet
    status(41, 0x01, 3000) // ~1 s later: panel group
    expect(events.filter((e) => e.nodeId === 41).map((e) => e.event)).toEqual(['new on the bus'])
  })

  it('"new on the bus" is logged when the node identifies, not when it is first seen', () => {
    const { events, status } = withEvents()
    status(41, 0x00, 0)
    expect(events.filter((e) => e.event === 'new on the bus')).toEqual([])
    status(41, 0x01, 1000) // the kind delta, ~1 s later
    expect(events.filter((e) => e.event === 'new on the bus')).toMatchObject([{ nodeId: 41 }])
  })
})

describe('bench capture, v3 firmware (2026-10-16)', () => {
  it('reads the rig’s roster: the bridge row is the link, Center_Armament is online and degraded', () => {
    const { h, roster } = hub()
    // Verbatim from the bench rig (PanelBridge + one panel group on the latest firmware).
    for (const line of [
      '_NODE_STATUS 000100002D000000002E00000003',
      '_NODE_STATUS 010100002C000000002702000101',
      '_NODE_STATUS_END 2'
    ]) {
      const [id, arg = ''] = line.split(' ')
      roster.applyMessage(id!, arg, 0)
    }
    const nodes = h.snapshot(0).model.nodes
    expect(nodes.some((n) => n.nodeId === 0)).toBe(false)
    expect(nodes.find((n) => n.nodeId === 1)).toMatchObject({
      name: 'Center_Armament',
      availability: 'online',
      identified: 'panel',
      status: { degraded: true, faultId: 1, faultLabel: 'I2C peripheral', nodeKind: 1 }
    })
  })
})
