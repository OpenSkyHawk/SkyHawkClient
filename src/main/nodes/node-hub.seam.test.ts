// HUB-seam contract tests (Phase 0, rows B8, B10, B33): NodeHub's public API — statusLine,
// telemetry, flush, snapshot and the mutators — with the mapping store kept in memory. They pin
// what the app does today, so the refactor can show it still does.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogEventInput } from '@shared/events'
import type { NodeMappingFile } from '@shared/nodes'
import { NODE_END_MSG, NODE_MSG, NodeRoster } from './node-status-wire'
import { statusRow } from '../../test-fixtures/nodes'

const disk: { file: NodeMappingFile; saves: number } = { file: { version: 3, nodes: {} }, saves: 0 }
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } })) // debug log path
vi.mock('./mapping-store', () => ({
  MappingSaveError: class MappingSaveError extends Error {},
  loadNodeMapping: () => ({ file: disk.file }),
  saveNodeMapping: (f: NodeMappingFile) => {
    disk.file = f
    disk.saves++
  }
}))

const { NodeHub } = await import('./node-hub')

const T0 = '2026-10-14T21:14:00.000Z'
const PANEL = 0x01
const PDU = 0x02
const NOT_REPORTED = 0x00

/** A hub on a roster, recording its pushes and its event-log rows. */
function hub() {
  const roster = new NodeRoster()
  const events: LogEventInput[] = []
  const h = new NodeHub(
    () => {},
    roster,
    (e) => events.push(...e)
  )
  /** One `_NODE_STATUS` row reaching the roster and the hub, as the device link feeds them. */
  const status = (id: number, kind: number, t: number, present = true) => {
    const row = statusRow(id, present, kind)
    roster.applyMessage(NODE_MSG, row, t)
    h.statusLine(NODE_MSG, `_NODE_STATUS ${row}`, t)
  }
  /** `_NODE_STATUS_END`: the roster reply is complete. */
  const end = (count: number, t: number) => {
    roster.applyMessage(NODE_END_MSG, String(count), t)
    h.statusLine(NODE_END_MSG, `_NODE_STATUS_END ${count}`, t)
  }
  /** The 200 ms link flush. */
  const flush = (t: number) => h.flush(roster.takeDirty(), t)
  const node = (id: number, t: number) => h.snapshot(t).model.nodes.find((n) => n.nodeId === id)
  return { h, roster, events, status, end, flush, node }
}

beforeEach(() => {
  disk.file = { version: 3, nodes: {} }
  disk.saves = 0
})

describe('B8 Forget removes everything; a forgotten board that reports is new again', () => {
  it('a registry board: its entry is gone, and back on the bus it is new, pre-filled from NODE_IDS.md', () => {
    // Added, renamed, placed, given a power zone, hidden, and seen before. Offline now.
    disk.file = {
      version: 3,
      nodes: {
        1: { added: true },
        2: { added: true, name: 'Nav', console: 'Left', pduId: 3, hidden: true, lastSeen: T0 }
      }
    }
    const { h, status, end, flush, node } = hub()
    status(1, PANEL, 0) // a completed roster without board 2: it is offline, not unknown
    end(1, 0)
    flush(0)
    expect(h.snapshot(0).model).toMatchObject({ rosterComplete: true, hidden: [2] })

    expect(h.forget(2).ok).toBe(true)
    expect(disk.file.nodes[2], 'name, placement, hidden flag and last seen all go').toBeUndefined()

    status(2, PANEL, 5000) // it reports again, as a panel group
    flush(5000)
    expect(node(2, 5000)).toMatchObject({
      source: 'new',
      name: 'Right_Navigation',
      console: null,
      registry: { name: 'Right_Navigation', console: 'Right', pduId: 4 }
    })
    expect(h.snapshot(5000).model.hidden, 'not hidden any more').toEqual([])
    expect(disk.file.nodes[2], 'a new board is never written').toBeUndefined()
  })

  it('an adopted board: its entry is gone, and back on the bus it is new, with nothing pre-filled', () => {
    disk.file = {
      version: 3,
      nodes: {
        1: { added: true },
        41: { name: 'Left_Trim', console: 'Left', kind: 'panel', pduId: 3, lastSeen: T0 }
      }
    }
    const { h, status, end, flush, node } = hub()
    status(1, PANEL, 0)
    end(1, 0)
    flush(0)

    expect(h.forget(41).ok).toBe(true)
    expect(disk.file.nodes[41]).toBeUndefined()

    status(41, PANEL, 5000)
    flush(5000)
    const back = node(41, 5000)
    expect(back).toMatchObject({ source: 'new', name: 'Node 41', console: null, pduId: null })
    expect(back?.registry).toBeUndefined()
    expect(disk.file.nodes[41]).toBeUndefined()
  })
})

describe('B10 Hide keeps links: boards fed by a hidden PDU keep their power zone (HUB half)', () => {
  it('hiding a PDU leaves its boards linked to it, and when it reports the group is whole again', () => {
    // Board 1 is placed under PDU 4 explicitly (its NODE_IDS.md default is PDU 5); board 2 is fed
    // by PDU 4 by default (Right console).
    disk.file = {
      version: 3,
      nodes: { 1: { added: true, pduId: 4 }, 2: { added: true }, 4: { added: true } }
    }
    const { h, status, end, flush, node } = hub()
    status(1, PANEL, 0)
    status(2, PANEL, 0)
    end(2, 0) // PDU 4 is not on the bus: it can be hidden
    flush(0)

    expect(h.hide(4, true).ok).toBe(true)
    expect(disk.file.nodes[4]?.hidden).toBe(true)
    expect(disk.file.nodes[1]?.pduId, 'the explicit link is kept in the file').toBe(4)
    expect(disk.file.nodes[2]?.pduId, 'the default link stays the default').toBeUndefined()
    expect(h.snapshot(0).model.hidden).toEqual([4])
    expect([node(1, 0)?.pduId, node(2, 0)?.pduId], 'both still name PDU 4').toEqual([4, 4])

    status(4, PDU, 5000) // the PDU reports: its hidden flag clears, and its boards are still its own
    flush(5000)
    expect(disk.file.nodes[4]?.hidden).toBeUndefined()
    expect(h.snapshot(5000).model.hidden).toEqual([])
    expect(disk.file.nodes[1]?.pduId).toBe(4)
    expect([node(1, 5000)?.pduId, node(2, 5000)?.pduId]).toEqual([4, 4])
    expect(node(4, 5000)).toMatchObject({ kind: 'pdu', availability: 'online' })
  })
})

describe('B33 a board identified only by PDU telemetry is "new on the bus" at its next status row', () => {
  it('no row when the pages arrive; one row, at that time, when its next status row comes', () => {
    const { h, events, status, end, node } = hub()
    status(1, PANEL, 0)
    end(1, 0) // the baseline is closed: what appears from here on is news
    const news = () => events.filter((e) => e.nodeId === 9 && e.event === 'new on the bus')

    status(9, NOT_REPORTED, 1000) // first sight: it has not said what it is
    expect(news()).toEqual([])

    const page = '090100E02E182EBC02' // node 9, 12 V rail page: it is a PDU
    h.telemetry(page, 1500, `_NODE_TELEM ${page}`)
    expect(node(9, 1500)?.identified).toBe('pdu')
    expect(news(), 'the pages identify it, but write no row').toEqual([])

    status(9, NOT_REPORTED, 5000) // the next roster poll
    expect(news()).toEqual([expect.objectContaining({ nodeId: 9, t: 5000, severity: 'new' })])

    status(9, NOT_REPORTED, 10_000)
    expect(news(), 'once per board').toHaveLength(1)
  })
})
