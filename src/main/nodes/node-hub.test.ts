import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeMappingFile, NodeModel } from '@shared/nodes'
import { NODE_END_MSG, NODE_MSG, NodeRoster } from './node-status-wire'
import { importMapping } from './mapping-rules'

const disk: {
  file: NodeMappingFile
  saves: number
  readOnly?: string
  fail?: boolean
} = {
  file: { version: 4, nodes: {} },
  saves: 0
}
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } })) // debug log path
vi.mock('./mapping-file', () => {
  class MappingSaveError extends Error {
    constructor(
      message: string,
      readonly reason: string
    ) {
      super(message)
    }
  }
  return {
    MappingSaveError,
    loadNodeMapping: () => ({ file: disk.file, readOnly: disk.readOnly }),
    saveNodeMapping: (f: NodeMappingFile) => {
      if (disk.fail) {
        const reason = 'the disk is read-only in /u'
        throw new MappingSaveError(`Node mapping could not be saved (${reason})`, reason)
      }
      disk.file = f
      disk.saves++
    }
  }
})

const { NodeHub } = await import('./node-hub')
const { buildCockpitSnapshot } = await import('./cockpit-snapshot')
const { requireAdoptable } = await import('./node-kind')

const T0 = '1970-01-01T00:00:00.000Z'
/** The registry boards added to your cockpit (#93): the setup most tests assume. */
const added = (): NodeMappingFile => ({
  version: 4,
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

/**
 * A hub whose roster has come back empty: every board in your cockpit is offline, so Hide and
 * Forget are allowed (offline-actions.ts) — before any roster they are refused (M1/C3).
 */
function offlineHub() {
  const r = hub()
  r.roster.applyMessage(NODE_END_MSG, '0', 0)
  return r
}

describe('NodeHub', () => {
  beforeEach(() => {
    disk.file = added()
    disk.saves = 0
    disk.readOnly = undefined
    disk.fail = false
  })

  it('a failed save is reported, and the change is not applied', () => {
    disk.file = { version: 4, nodes: { 1: { added: true, lastSeen: T0 } } }
    const { h, pushes } = hub()
    disk.fail = true
    expect(h.setMapping(1, { name: 'Armament' })).toEqual({
      ok: false,
      error: 'Node mapping could not be saved (the disk is read-only in /u)'
    })
    expect(h.snapshot().model.nodes.find((n) => n.nodeId === 1)?.name).toBe('Center_Armament')
    expect(pushes.filter(([c]) => c === 'nodes:model')).toEqual([])
  })

  it('a read-only mapping (newer client, unreadable) refuses every save', () => {
    disk.readOnly = 'node-mapping.json was written by a newer client'
    const { h } = offlineHub()
    expect(h.hide(2, true)).toEqual({
      ok: false,
      error: 'Not saved: node-mapping.json was written by a newer client'
    })
    expect(disk.saves).toBe(0)
  })

  it('a reporting board is un-hidden even when that save fails', () => {
    disk.file = { version: 4, nodes: { 2: { hidden: true, added: true } } }
    disk.fail = true
    const { h, roster } = hub()
    roster.applyMessage(NODE_MSG, '0201000000000000008000000000', 0)
    h.flush(roster.takeDirty(), 0)
    expect(h.snapshot(0).model.hidden).toEqual([])
    expect(disk.file.nodes).toEqual({ 2: { hidden: true, added: true } }) // not on disk
  })

  it('clears "hidden until it reports again" once the node reports, and saves it', () => {
    disk.file = { version: 4, nodes: { 1: { added: true }, 2: { hidden: true, added: true } } }
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
    disk.file = { version: 4, nodes: {} }
    const { h, roster } = hub()
    roster.applyMessage(NODE_MSG, '2901000000000000008000000001', 0) // node 41
    roster.applyMessage(NODE_MSG, '0101000000000000008000000001', 0) // registry board 1
    h.flush(roster.takeDirty(), 0)
    expect(disk.saves).toBe(0)
    expect(h.snapshot(0).model.nodes.map((n) => [n.nodeId, n.source])).toEqual([
      [1, 'new'],
      [41, 'new']
    ])
    // PDU_Center is not in your cockpit, so the pre-fill — and the request — has No power zone (D7).
    const spec = { name: 'Center_Armament', console: 'Center', pduId: null, kind: 'panel' } as const
    expect(h.adopt(1, spec).ok).toBe(true) // Add to cockpit
    // the kind it reported (S1)
    expect(disk.file.nodes[1]).toEqual({ added: true, kind: 'panel', pduId: null })
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

  it('every model pushed carries a rising rev; nodes:get answers the last push’s (C5)', () => {
    const { h, pushes } = hub()
    const revs = () =>
      pushes.filter(([c]) => c === 'nodes:model').map(([, m]) => (m as NodeModel).rev)
    h.setMapping(1, { name: 'Armament' })
    h.setMapping(1, { name: 'Armament_2' })
    const [a, b] = revs()
    expect(b).toBe(a! + 1)
    expect(h.snapshot().model.rev).toBe(b)
    // A refused change pushes nothing and answers the same rev.
    h.setMapping(1, { name: ' ' })
    expect(revs()).toHaveLength(2)
    expect(h.snapshot().model.rev).toBe(b)
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

  it('Add all (R3.2b) adopts each board in turn, each pushed as it lands; a refusal stops it', async () => {
    const { h, roster, pushes } = hub()
    // 41 and 42 report as panel groups; 43 has not said what it is.
    for (const id of [41, 42, 43]) {
      const kind = id === 43 ? '00' : '01'
      roster.applyMessage(
        NODE_MSG,
        `${id.toString(16).toUpperCase()}010000000000000080000000${kind}`,
        0
      )
    }
    h.flush(roster.takeDirty(), 0)
    const spec = (name: string) => ({ name, console: 'Left', pduId: null, kind: 'panel' }) as const
    pushes.length = 0
    const r = await h.addAll([
      { nodeId: 41, spec: spec('A') },
      { nodeId: 43, spec: spec('C') },
      { nodeId: 42, spec: spec('B') }
    ])
    expect(r).toEqual({
      ok: false,
      done: [41],
      nodeId: 43,
      error: 'Its board type is not known yet',
      failed: [{ nodeId: 43, error: 'Its board type is not known yet' }]
    })
    expect(Object.keys(disk.file.nodes).map(Number)).toEqual([1, 2, 3, 4, 5, 41])
    // One adopt's pushes, as one node-mapping:adopt invoke made them; 42 was not tried.
    expect(pushes.map(([c]) => c)).toEqual(['cockpit:snapshot', 'nodes:model'])

    pushes.length = 0
    expect(await h.addAll([{ nodeId: 42, spec: spec('B') }])).toEqual({ ok: true, done: [42] })
    expect(pushes.map(([c]) => c)).toEqual(['cockpit:snapshot', 'nodes:model'])
  })

  // N4 (#133): a refusal no longer stops it — every board is tried, each refusal listed.
  it('Un-hide all (R3.2b) un-hides each board in turn, each pushed as it lands', async () => {
    disk.file = {
      version: 4,
      nodes: { 1: { added: true, hidden: true }, 2: { added: true, hidden: true } }
    }
    const { h, pushes } = hub()
    expect(await h.unhide([2, 1])).toEqual({ ok: true, done: [2, 1] })
    expect(disk.file.nodes).toEqual({ 1: { added: true }, 2: { added: true } })
    expect(pushes.map(([c]) => c)).toEqual([
      'cockpit:snapshot',
      'nodes:model',
      'cockpit:snapshot',
      'nodes:model'
    ])
    disk.file = { version: 4, nodes: { 1: { added: true, hidden: true } } }
    disk.readOnly = 'node-mapping.json was written by a newer client'
    const ro = hub().h
    const notSaved = 'Not saved: node-mapping.json was written by a newer client'
    // #1 can't be saved; #2 is tried after it (already shown, so nothing to save).
    expect(await ro.unhide([1, 2])).toEqual({
      ok: false,
      done: [2],
      nodeId: 1,
      error: notSaved,
      failed: [{ nodeId: 1, error: notSaved }]
    })
  })

  it('hiding a new node is refused and writes nothing', () => {
    const { h } = offlineHub()
    expect(h.hide(41, true)).toEqual({
      ok: false,
      error: 'Only a board in your cockpit can be hidden'
    })
    expect(disk.saves).toBe(0)
    expect(h.hide(2, true).ok).toBe(true)
  })

  it('forgetting an offline PDU (#93) unlinks the boards it fed; resetBoard never relinks it (S1)', () => {
    disk.file = {
      version: 4,
      nodes: { 2: { added: true, lastSeen: T0, name: 'Nav' }, 4: { added: true, lastSeen: T0 } }
    }
    const { h } = offlineHub()
    expect(h.forget(4).ok).toBe(true)
    expect(disk.file.nodes).toEqual({ 2: { added: true, lastSeen: T0, name: 'Nav', pduId: null } })
    expect(h.resetBoard(2).ok).toBe(true)
    // Still in your cockpit, its name back to the registry's — but not linked to the PDU you forgot.
    expect(disk.file.nodes).toEqual({ 2: { added: true, lastSeen: T0, pduId: null } })
  })

  it('a non-boolean on/off is refused; a no-op change writes and pushes nothing', () => {
    const { h, pushes } = offlineHub()
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

  it('a config import never hides a board that is on the bus (#93 re-review K)', () => {
    const { h, roster } = hub()
    roster.applyMessage(NODE_MSG, '0101000000000000008000000001', 0) // node 1 online
    h.flush(roster.takeDirty(), 0)
    expect(h.onlineIds()).toEqual([1])
    // ConfigTransfer stages the import over the hub's mapping and online boards, then saves it.
    const file: NodeMappingFile = {
      version: 4,
      nodes: { 1: { added: true, hidden: true }, 2: { added: true, hidden: true } }
    }
    expect(
      h.replaceMapping(importMapping(h.mappingFile(), h.registryDefaults(), file, h.onlineIds())).ok
    ).toBe(true)
    expect(disk.file.nodes[1]?.hidden).toBeUndefined()
    expect(disk.file.nodes[2]?.hidden).toBe(true)
  })

  it('a config import brings membership as written; this computer keeps only its last seen (D3)', () => {
    disk.file = {
      version: 4,
      nodes: { 2: { added: true, lastSeen: T0, name: 'Nav' }, 3: { added: true, lastSeen: T0 } }
    }
    const { h } = hub()
    const file: NodeMappingFile = {
      version: 4,
      nodes: {
        2: { added: true, name: 'Nav_2', lastSeen: '2020-01-01T00:00:00.000Z' },
        4: { added: true }
      }
    }
    expect(h.replaceMapping(importMapping(h.mappingFile(), h.registryDefaults(), file)).ok).toBe(
      true
    )
    // 3 left (the file does not have it), 4 joined; 2 kept this computer's last seen.
    expect(disk.file.nodes).toEqual({
      2: { name: 'Nav_2', added: true, lastSeen: T0 },
      4: { added: true }
    })
  })

  it('replaceMapping saves before it adopts: a failed save changes nothing (C2/M10)', () => {
    const { h } = hub()
    const before = h.mappingFile()
    disk.fail = true
    // The reason alone: the import names the section itself ("Node mapping could not be saved").
    expect(h.replaceMapping({ version: 4, nodes: {} })).toEqual({
      ok: false,
      error: 'the disk is read-only in /u'
    })
    expect(h.mappingFile()).toBe(before)
    disk.fail = false
    disk.readOnly = 'node-mapping.json was written by a newer client'
    expect(hub().h.replaceMapping({ version: 4, nodes: {} })).toEqual({
      ok: false,
      error: 'node-mapping.json was written by a newer client'
    })
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
      version: 4,
      nodes: {
        1: { added: true },
        41: { added: true, name: 'Aft', console: 'Left', kind: 'panel', pduId: 3 }
      }
    }
    const { h, roster } = hub()
    roster.applyMessage(NODE_MSG, row(41, 0x02), 0)
    expect(node(h, 41)).toMatchObject({ kind: 'pdu', identified: 'pdu', pduId: null })
    expect(h.setMapping(41, { pduId: 3 })).toEqual({ ok: false, error: 'A PDU has no power zone' })
    expect(h.setMapping(1, { pduId: 41 }).ok).toBe(true) // another panel can be fed by it
  })

  it('a registry panel ID that reports PDU is a PDU; a registry PDU that says nothing stays one', () => {
    disk.file = { version: 4, nodes: { 3: { added: true, lastSeen: T0 } } }
    const { h, roster } = hub()
    roster.applyMessage(NODE_MSG, row(2, 0x02), 0) // Right_Navigation's ID, on a PDU
    expect(node(h, 2)).toMatchObject({ kind: 'pdu', identified: 'pdu' })
    expect(node(h, 3)).toMatchObject({ kind: 'pdu', identified: 'pdu' }) // PDU_Left, no report
  })

  it('bug 3 (S1): a registry panel ID added as a PDU still reads PDU offline, after a restart', () => {
    disk.file = { version: 4, nodes: {} }
    const first = hub()
    first.roster.applyMessage(NODE_MSG, row(2, 0x02), 0) // Right_Navigation's ID, on a PDU
    const spec = { name: 'PDU_Nav', console: 'Right', pduId: null, kind: 'pdu' } as const
    expect(first.h.adopt(2, spec).ok).toBe(true)
    expect(disk.file.nodes[2]).toEqual({ added: true, name: 'PDU_Nav', kind: 'pdu' })
    const { h } = hub() // the next launch: nothing on the bus yet
    expect(node(h, 2)).toMatchObject({ kind: 'pdu', availability: 'unknown' })
  })

  it('the kind a board in your cockpit reports is stored, once (S1)', () => {
    // A v3 file never stored a registry board's kind: it is stored the next time the board reports.
    disk.file = { version: 4, nodes: { 1: { added: true }, 2: { added: true } } }
    const { h, roster } = hub()
    roster.applyMessage(NODE_MSG, row(1, 0x02), 0) // reports PDU
    roster.applyMessage(NODE_MSG, row(41, 0x01), 0) // not in your cockpit
    h.flush(roster.takeDirty(), 0)
    expect(disk.file.nodes[1]).toMatchObject({ added: true, kind: 'pdu' })
    expect(disk.file.nodes[2]).toEqual({ added: true }) // said nothing yet
    expect(disk.file.nodes[41]).toBeUndefined()
    const saves = disk.saves
    roster.applyMessage(NODE_MSG, row(1, 0x02), 5000) // the same report again: no write
    h.flush(true, 5000)
    expect(disk.saves).toBe(saves)
    // PDU pages are a report too — and, online by them, it was seen now (D8 / S5, #133).
    h.telemetry('020100E02E182EBC02', 6000)
    h.flush(false, 6000)
    expect(disk.file.nodes[2]).toEqual({
      added: true,
      kind: 'pdu',
      lastSeen: new Date(6000).toISOString()
    })
  })

  it('Forget of a PDU that has not reported this session unlinks its boards (S1)', () => {
    // Right_Navigation's ID reported PDU last session; Center_Armament is fed by it.
    disk.file = {
      version: 4,
      nodes: { 1: { added: true, pduId: 2 }, 2: { added: true, kind: 'pdu', lastSeen: T0 } }
    }
    const { h } = offlineHub() // nothing on the bus
    expect(h.forget(2).ok).toBe(true)
    expect(disk.file.nodes).toEqual({ 1: { added: true, pduId: null } })
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
    disk.file = { version: 4, nodes: {} }
    const { h, roster } = hub()
    // PDU_Center is not in your cockpit, so the pre-fill has No power zone (D7).
    const spec = { name: 'Center_Armament', console: 'Center', pduId: null, kind: 'panel' } as const
    roster.applyMessage(NODE_MSG, row(1, 0x00), 0) // kind not reported yet
    expect(node(h, 1)?.identified).toBeUndefined()
    expect(h.adopt(1, spec)).toEqual({ ok: false, error: 'Its board type is not known yet' })
    roster.applyMessage(NODE_MSG, row(1, 0x03), 10) // a bridge on a registry panel's ID
    expect(h.adopt(1, spec)).toEqual({ ok: false, error: 'This board cannot be adopted' })
    roster.applyMessage(NODE_MSG, row(1, 0x01), 20) // a panel group
    expect(h.adopt(1, spec).ok).toBe(true)
    // the kind it reported (S1)
    expect(disk.file.nodes[1]).toEqual({ added: true, kind: 'panel', pduId: null })
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

describe('one rule for the footer and main (M1/C3, S7)', () => {
  beforeEach(() => {
    disk.file = added()
    disk.saves = 0
    disk.readOnly = undefined
    disk.fail = false
  })

  const row = (id: number, kind: number, present = true) =>
    `${id.toString(16).padStart(2, '0')}${present ? '01' : '00'}0000000000000080000000${kind
      .toString(16)
      .padStart(2, '0')}`.toUpperCase()
  const NOW = 10_000
  /** PDU_Right's (#4) 12 V page, as `_NODE_TELEM` carries it. */
  const PDU4_PAGE = '040100E02E182EBC02'

  /** A hub where board `id` is `state` by the roster, and maybe sending fresh PDU pages. */
  function scene(
    id: number,
    kind: number,
    state: 'online' | 'offline' | 'unknown',
    pages: boolean
  ) {
    disk.file = added() // each scene starts from the same mapping
    const { h, roster } = hub()
    if (state !== 'unknown') {
      roster.applyMessage(NODE_MSG, row(id, kind, state === 'online'), 0)
      roster.applyMessage(NODE_END_MSG, '1', 0)
    }
    if (pages) h.telemetry(PDU4_PAGE, NOW)
    h.flush(roster.takeDirty(), NOW)
    return h
  }

  /** What the Cockpit footer offers, built from the hub's own push as the snapshot host does. */
  function footer(h: InstanceType<typeof NodeHub>, id: number) {
    const { model, telemetry } = h.snapshot(NOW)
    const { snapshot } = buildCockpitSnapshot({
      model,
      telemetry,
      device: { state: 'connected' },
      peakW: 0,
      now: NOW,
      rev: 0
    })
    return snapshot.panels[id]!.actions
  }

  const cases = [
    { id: 2, kind: 1, pages: false }, // a panel group
    { id: 4, kind: 2, pages: false }, // a PDU, no pages
    { id: 4, kind: 2, pages: true } // a PDU sending fresh pages
  ]
  for (const c of cases) {
    for (const state of ['online', 'offline', 'unknown'] as const) {
      it(`#${c.id}${c.pages ? ' with fresh pages' : ''}, ${state}: Forget and Hide agree`, () => {
        const offered = footer(scene(c.id, c.kind, state, c.pages), c.id)
        const forgot = scene(c.id, c.kind, state, c.pages).forget(c.id, NOW)
        const hid = scene(c.id, c.kind, state, c.pages).hide(c.id, true, NOW)
        expect(forgot.ok).toBe(!offered.forget.disabled)
        expect(hid.ok).toBe(!offered.hide.disabled)
        // Allowed exactly when it is offline by the roster and sends no fresh pages.
        expect(forgot.ok).toBe(state === 'offline' && !c.pages)
        if (state === 'unknown' && !c.pages) {
          // The reason main refuses with is the footer's own line.
          expect(forgot).toEqual({ ok: false, error: offered.note })
        }
      })
    }
  }

  // S7: every adopt path goes through requireAdoptable — main's mutators (an unregistered NODE_ID
  // and a registry board), NodeHub.adopt and Add all, and the Adopt dialog's form (its row kind).
  const said = [
    { byte: 0, identity: undefined },
    { byte: 1, identity: 'panel' },
    { byte: 2, identity: 'pdu' },
    { byte: 3, identity: 'bridge' },
    { byte: 9, identity: 'other' }
  ] as const
  for (const { byte, identity } of said) {
    it(`a board that reports ${identity ?? 'nothing'}: every adopt path answers as requireAdoptable`, async () => {
      disk.file = { version: 4, nodes: {} }
      const gate = (as?: 'pdu' | 'panel') => {
        try {
          return { ok: true, kind: requireAdoptable(identity, as) }
        } catch (err) {
          return { ok: false, error: (err as Error).message }
        }
      }
      const { h, roster } = hub()
      roster.applyMessage(NODE_MSG, row(41, byte), 0) // unregistered
      roster.applyMessage(NODE_MSG, row(2, byte), 0) // Right_Navigation, not added yet
      h.flush(roster.takeDirty(), 0)
      const spec = (name: string) =>
        ({ name, console: 'Right', pduId: null, kind: 'panel' }) as const
      const answer = (r: { ok: boolean; error?: string }) =>
        r.ok ? { ok: true } : { ok: false, error: r.error }
      const asked = gate('panel')
      expect(answer(h.adopt(41, spec('Aux')))).toEqual(
        asked.ok ? { ok: true } : { ok: false, error: asked.error }
      )
      const reg = gate()
      expect(answer(h.adopt(2, spec('Right_Navigation')))).toEqual(
        reg.ok ? { ok: true } : { ok: false, error: reg.error }
      )
      // Add all is one adopt each: the same answer for the next board that reports the same.
      roster.applyMessage(NODE_MSG, row(42, byte), 0)
      h.flush(roster.takeDirty(), 0)
      const all = await h.addAll([{ nodeId: 42, spec: spec('Aux2') }])
      expect(all.ok).toBe(asked.ok)
      // The dialog offers a form only for what the gate lets through, as that kind.
      disk.file = { version: 4, nodes: {} }
      const fresh = hub()
      fresh.roster.applyMessage(NODE_MSG, row(43, byte), 0)
      fresh.h.flush(fresh.roster.takeDirty(), 0)
      const { snapshot } = buildCockpitSnapshot({
        ...fresh.h.snapshot(0),
        device: { state: 'connected' },
        peakW: 0,
        now: 0,
        rev: 0
      })
      const r = snapshot.adopt.find((x) => x.view.entry.nodeId === 43)!
      expect(r.kind).toBe(gate().ok ? identity : undefined)
    })
  }
})

describe('on the bus (X2 / S10) and a lost line inside a reply (#132)', () => {
  const NOW = 50_000
  const line = (id: number, present = true, kind = 1) =>
    `${id.toString(16).padStart(2, '0')}${present ? '01' : '00'}0000000000000080000000${kind
      .toString(16)
      .padStart(2, '0')}`

  /** A hub fed as the Gateway's line tap feeds it, with its debug log and event rows recorded. */
  function tapped() {
    const roster = new NodeRoster()
    const logged: string[] = []
    const events: string[] = []
    const h = new NodeHub(
      () => {},
      roster,
      (e) => events.push(...e.map((x) => `${x.nodeId ?? '-'} ${x.event}`)),
      { log: (tag, data) => logged.push(`${tag} ${String(data)}`) }
    )
    const tap = (identifier: string, arg: string, t: number) =>
      h.nodeLine(identifier, arg, `${identifier} ${arg}`, t)
    /** One roster reply, node 0 first, END with PanelBridge's count; `lost` lines never arrive. */
    const reply = (ids: number[], t: number, lost: number[] = []) => {
      h.requestNodes()
      for (const id of [0, ...ids])
        if (!lost.includes(id)) tap(NODE_MSG, line(id, true, id ? 1 : 3), t)
      tap(NODE_END_MSG, String(ids.length + 1), t)
      h.flush(roster.takeDirty(), t)
    }
    const node = (id: number, t: number) => h.snapshot(t).model.nodes.find((n) => n.nodeId === id)
    return { h, roster, logged, events, reply, node, tap }
  }

  it('a PDU in your cockpit sending fresh pages is online, and Hide and Forget agree', () => {
    disk.file = added()
    const { h, reply, node } = tapped()
    reply([1], 0) // a whole roster without PDU_Right (#4)
    expect(node(4, 0)?.availability).toBe('offline')
    h.telemetry('040100E02E182EBC02', NOW) // its fresh 12 V page
    expect(node(4, NOW)).toMatchObject({ availability: 'online', readings: 'live' })
    expect(h.forget(4, NOW).ok).toBe(false)
    expect(h.hide(4, true, NOW).ok).toBe(false)
  })

  it('a reply short of its count marks nobody offline, logs one debug line and no event row', () => {
    disk.file = added()
    const { reply, node, logged, events } = tapped()
    reply([1, 2], 0)
    const before = events.length
    reply([1, 2], 5000, [2]) // board 2's line is lost
    expect(node(2, 5000)?.availability).toBe('online')
    expect(logged.filter((l) => /incomplete/.test(l))).toEqual([
      'node roster reply incomplete: 2 of 3 rows; absences not reconciled'
    ])
    expect(events.slice(before)).toEqual([])
    reply([1, 2], 10_000) // the next whole reply: still there
    expect(node(2, 10_000)?.availability).toBe('online')
    reply([1], 15_000) // board 2 really left: a whole reply says so, and the log has its row
    expect(node(2, 15_000)?.availability).toBe('offline')
    expect(events.slice(before)).toEqual(['2 offline'])
    expect(logged.filter((l) => /incomplete/.test(l))).toHaveLength(1)
  })
})

describe('a PDU’s pages against the roster: the newest evidence wins (X2, #132)', () => {
  const PAGE = '040100E02E182EBC02' // PDU_Right's (#4) 12 V page
  const row = (id: number, present = true, kind = 1) =>
    `${id.toString(16).padStart(2, '0')}${present ? '01' : '00'}0000000000000080000000${kind
      .toString(16)
      .padStart(2, '0')}`

  /**
   * PDU_Right (#4) feeds Right_Navigation (#2); both and Center_Armament (#1) are on the bus, and
   * the PDU sends a page every second until `pagesUntil`. At 13 s the bridge's heartbeat timeout
   * reports #4 and #2 absent: the PDU lost power at 10 s.
   */
  function powerLoss(pagesUntil: number, now: number) {
    disk.file = {
      version: 4,
      nodes: { 1: { added: true }, 2: { added: true, pduId: 4 }, 4: { added: true } }
    }
    const roster = new NodeRoster()
    const h = new NodeHub(() => {}, roster)
    const tap = (identifier: string, arg: string, t: number) =>
      h.nodeLine(identifier, arg, `${identifier} ${arg}`, t)
    tap(NODE_MSG, row(0, true, 3), 0)
    for (const id of [1, 2, 4]) tap(NODE_MSG, row(id, true, id === 4 ? 2 : 1), 0)
    tap(NODE_END_MSG, '4', 0)
    h.flush(roster.takeDirty(), 0)
    for (let t = 0; t <= Math.min(pagesUntil, now); t += 1000) h.telemetry(PAGE, t)
    if (now >= 13_000) {
      tap(NODE_MSG, row(4, false, 2), 13_000) // live deltas: the heartbeat timeout
      tap(NODE_MSG, row(2, false), 13_000)
    }
    h.flush(roster.takeDirty(), now)
    const { model, telemetry } = h.snapshot(now)
    const { snapshot } = buildCockpitSnapshot({
      model,
      telemetry,
      device: { state: 'connected' },
      peakW: 0,
      now,
      rev: 0
    })
    return { h, model, snapshot }
  }

  it('a PDU that loses power is offline on the roster’s timing and folds into its outage', () => {
    // 13.2 s: its last page (10 s) is still fresh for 6.8 s more, but the roster said absent after it.
    const { h, model, snapshot } = powerLoss(10_000, 13_200)
    expect(model.nodes.find((n) => n.nodeId === 4)).toMatchObject({
      availability: 'offline',
      offlineAt: 13_000
    })
    expect(model.outages).toEqual([
      expect.objectContaining({ pduId: 4, nodeIds: [2], fedCount: 1, at: 13_000 })
    ])
    // Every surface reads the same: one outage item, and the footer offers what main allows.
    expect(snapshot.attention.items.map((i) => [i.nodeId, i.flag])).toEqual([
      [4, 'OFFLINE · 1 node affected']
    ])
    expect(snapshot.panels[4]!.actions.forget.disabled).toBe(false)
    expect(h.hide(4, true, 13_200).ok).toBe(true)
  })

  it('pages arriving after the roster said absent bring it back online', () => {
    const { h, model, snapshot } = powerLoss(14_000, 14_200) // a page at 14 s, after the 13 s absent
    expect(model.nodes.find((n) => n.nodeId === 4)?.availability).toBe('online')
    expect(model.outages).toEqual([])
    expect(snapshot.panels[4]!.actions.forget.disabled).toBe(true)
    expect(h.forget(4, 14_200).ok).toBe(false)
    expect(h.hide(4, true, 14_200).ok).toBe(false)
  })

  it('before the roster says absent, a powered PDU is online by both', () => {
    const { model } = powerLoss(10_000, 12_000)
    expect(model.nodes.find((n) => n.nodeId === 4)?.availability).toBe('online')
  })
})
