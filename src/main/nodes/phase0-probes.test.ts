// Phase-0 behaviour probes (SkyHawkClient#97, arch-phase0-contract PART 1B/1C): each test asserts
// TODAY's behaviour for a fix-track or conflict row, so the structure rewrite can show it changed
// nothing. A fix ticket that changes one of these behaviours on purpose updates its probe.
// Main and shared only; the probes that read renderer helpers are in
// src/renderer/src/phase0-probes.test.ts (main never imports renderer code).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PSU, type NodeDefaults, type NodeKind, type NodeMappingFile } from '@shared/nodes'
import { NODE_END_MSG, NODE_MSG, NodeRoster } from './node-status-wire'
import {
  importMapping,
  setNodeMapping,
  adoptNode,
  effectiveMapping,
  type KindOf
} from './mapping-rules'
import { boardIdentity } from './node-kind'
import { NODE_KINDS } from '@shared/firmware'
import { registryDefaults } from './registry'
import { diffImport, parseConfigFile } from '../config/config-file'
import { CONFIG_FORMAT } from '@shared/config'
import { buildNodeModel } from './node-model'
import { GatewayWatch, GATEWAY_NO_ANSWER_MS } from '../gateway/gateway-health'
import { DEFAULT_APP_SETTINGS } from '../../test-fixtures/config'

const disk: { file: NodeMappingFile } = { file: { version: 4, nodes: {} } }
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('./mapping-file', () => {
  class MappingSaveError extends Error {}
  return {
    MappingSaveError,
    loadNodeMapping: () => ({ file: disk.file }),
    saveNodeMapping: (f: NodeMappingFile) => {
      disk.file = f
    }
  }
})
const { NodeHub } = await import('./node-hub')

const REG = {
  0: { name: 'PanelBridge', console: '—' },
  1: { name: 'Center_Armament', console: 'Center' },
  2: { name: 'Right_Navigation', console: 'Right' },
  3: { name: 'PDU_Left', console: 'Left' },
  4: { name: 'PDU_Right', console: 'Right' },
  5: { name: 'PDU_Center', console: 'Center' }
}
const defaults = registryDefaults(REG)

/**
 * main's KindOf (NodeHub.kindOf, node-kind.ts boardIdentity): what a board reports now (`said`),
 * else the kind stored for a board in your cockpit. kindOf is required (S7), so every call says it.
 */
const kinds =
  (f: NodeMappingFile, d: Map<number, NodeDefaults>, said: Record<number, NodeKind> = {}): KindOf =>
  (id) =>
    boardIdentity(effectiveMapping(d, f), id, {
      reported: said[id] === undefined ? undefined : REPORTS[said[id]]
    })
const REPORTS = { panel: NODE_KINDS.PANEL_GROUP, pdu: NODE_KINDS.PDU } as const
const row = (id: number, kind: number, present = true) =>
  `${id.toString(16).padStart(2, '0')}${present ? '01' : '00'}0000000000000080000000${kind.toString(16).padStart(2, '0')}0000000000`.toUpperCase()
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

function hubWith(file: NodeMappingFile) {
  disk.file = file
  const events: { event: string; nodeId?: number; detail?: string }[] = []
  const roster = new NodeRoster()
  const h = new NodeHub(
    () => {},
    roster,
    (e) => events.push(...e)
  )
  const status = (id: number, kind: number, t: number, present = true) => {
    roster.applyMessage(NODE_MSG, row(id, kind, present), t)
    h.statusLine(NODE_MSG, `_NODE_STATUS ${row(id, kind, present)}`, t)
  }
  return { h, roster, events, status }
}

describe('fix-track probes (today)', () => {
  it('C1 (fixed, #136): nodeMapping {} and app {} are rejected, never read as empty or defaults', () => {
    const r = parseConfigFile(
      JSON.stringify({ format: CONFIG_FORMAT, version: 1, sections: { nodeMapping: {}, app: {} } })
    )
    expect(r).toEqual({
      ok: false,
      error:
        'This file has no settings this client can read. Node mapping: it has no version. ' +
        'App settings: it has no “Source mode” setting.'
    })
  })

  it('M1/C3 (fixed, #131): Forget is refused while availability is unknown, and for a PDU with fresh telemetry', () => {
    const a = hubWith(added())
    expect(a.h.snapshot(0).model.nodes.find((n) => n.nodeId === 2)?.availability).toBe('unknown')
    expect(a.h.forget(2).ok).toBe(false)
    const b = hubWith(added())
    b.roster.applyMessage(NODE_END_MSG, '0', 0) // a complete roster: PDU_Right is offline by it
    b.h.telemetry('040100E02E182EBC02', Date.now()) // PDU_Right pages, fresh; not in roster
    expect(b.h.forget(4).ok).toBe(false)
  })

  it('M3 / #132 (fixed): a reply whose rows were dropped completes nothing — unknown, Forget refused', () => {
    // Was: the END completed the roster, so added boards read offline and Forget was allowed. The
    // END says 2 rows and none arrived, so the reply is incomplete and reconciles nothing (#132).
    const a = hubWith(added())
    a.roster.beginBurst(0)
    a.roster.applyMessage(NODE_MSG, '0101000000000000008000', 0) // malformed row -> dropped
    a.roster.applyMessage(NODE_END_MSG, '2', 0)
    const n1 = a.h.snapshot(0).model.nodes.find((n) => n.nodeId === 1)
    expect(n1?.availability).toBe('unknown')
    expect(a.h.forget(1).ok).toBe(false)
  })

  it('C4 (fixed, #133): a node identified only by PDU telemetry logs "new on the bus" when its pages identify it', () => {
    const a = hubWith({ version: 4, nodes: {} })
    a.status(1, 1, 0)
    a.roster.applyMessage(NODE_END_MSG, '1', 0)
    a.h.statusLine(NODE_END_MSG, '_NODE_STATUS_END 1', 0)
    a.status(9, 0, 2000) // kind 0, never reports a kind
    a.h.telemetry('090100E02E182EBC02', 2500, '_NODE_TELEM 090100E02E182EBC02')
    expect(a.h.snapshot(2500).model.nodes.find((n) => n.nodeId === 9)?.identified).toBe('pdu')
    // Was: no row until its next status row (7000).
    expect(a.events.filter((e) => e.nodeId === 9 && e.event === 'new on the bus')).toMatchObject([
      { t: 2500 }
    ])
    a.status(9, 0, 7000) // next roster poll row: no second row
    expect(a.events.filter((e) => e.nodeId === 9 && e.event === 'new on the bus')).toHaveLength(1)
  })

  it('C4 (fixed, #133): the "seen new" record is cleared on Forget — re-plugged, it is new again', () => {
    const a = hubWith({ version: 4, nodes: {} })
    a.status(1, 1, 0)
    a.roster.applyMessage(NODE_END_MSG, '1', 0)
    a.h.statusLine(NODE_END_MSG, '_NODE_STATUS_END 1', 0)
    const news = () => a.events.filter((e) => e.nodeId === 41 && e.event === 'new on the bus')
    a.status(41, 1, 1000) // a panel group, not in your cockpit: new
    expect(news()).toHaveLength(1)
    const spec = { name: 'Left_Oxygen', console: 'Left', pduId: null, kind: 'panel' } as const
    expect(a.h.adopt(41, spec).ok).toBe(true)
    a.status(41, 1, 2000, false) // unplugged
    a.h.flush(true, 2000)
    expect(a.h.forget(41, 2000).ok).toBe(true)
    a.status(41, 1, 3000) // plugged back in
    expect(news()).toHaveLength(2)
  })

  it('X8 / C6 (fixed, #133): no source file words a new board the old way', () => {
    // The old wording for a board outside your cockpit — the flag, the fault box's title and the
    // log's detail — and the log's old detail for a registry one. Built here so this file passes.
    const old = [new RegExp(['not', 'in', 'registry'].join(' '), 'i'), /'in NODE_IDS\.md'/]
    const src = fileURLToPath(new URL('../..', import.meta.url))
    const hits = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .flatMap((f) => {
        const text = readFileSync(join(src, f), 'utf8')
        return old.filter((re) => re.test(text)).map((re) => `${f}: ${re.source}`)
      })
    expect(hits).toEqual([])
  })

  it('M7: hub.reset() (port reopen after error) clears wasPresent without writing lastSeen', () => {
    const a = hubWith(added())
    a.status(1, 1, 0)
    a.h.flush(true, 0)
    const seen0 = disk.file.nodes[1]?.lastSeen
    a.h.reset()
    a.h.linkClosed(60_000)
    expect(disk.file.nodes[1]?.lastSeen).toBe(seen0) // not 60 s
  })

  it('M7 contrast: linkClosed() before reset writes lastSeen', () => {
    const a = hubWith(added())
    a.status(1, 1, 0)
    a.h.flush(true, 0)
    a.h.linkClosed(60_000)
    expect(disk.file.nodes[1]?.lastSeen).toBe(new Date(60_000).toISOString())
  })

  it('G1: one unanswered poll trips "not responding" at exactly the poll interval', () => {
    const w = new GatewayWatch()
    w.answered('_NODE_STATUS_END', 0)
    w.asked(5000) // poll n
    // reply to poll n lost; poll n+1 at 10000 counts from the oldest unanswered
    w.asked(10000)
    expect(GATEWAY_NO_ANSWER_MS).toBe(5000)
    expect(w.tick(10000).length).toBe(1)
    expect(w.status()?.kind).toBe('not-responding')
  })

  it('D7 (fixed, #131): a zone to a registry PDU that is not in your cockpit is refused by main', () => {
    const f: NodeMappingFile = { version: 4, nodes: { 2: { added: true } } }
    expect(() => setNodeMapping(f, defaults, 2, { pduId: 3 }, kinds(f, defaults))).toThrow(
      'That PDU is not in your cockpit — add it first'
    ) // PDU_Left, not added
    const added: NodeMappingFile = { version: 4, nodes: { ...f.nodes, 3: { added: true } } }
    const g = setNodeMapping(added, defaults, 2, { pduId: 3 }, kinds(added, defaults))
    expect(g.nodes[2]).toEqual({ added: true, pduId: 3 })
  })

  it('D3 (fixed, #136): membership is imported as written, and the review lists the join', () => {
    const cur: NodeMappingFile = { version: 4, nodes: {} }
    const imp: NodeMappingFile = { version: 4, nodes: { 2: { added: true, name: 'Nav' } } }
    // D7 (#131): its NODE_IDS.md PDU, PDU_Right, is not in the imported cockpit: No power zone.
    expect(importMapping(cur, defaults, imp)).toEqual({
      version: 4,
      nodes: { 2: { added: true, name: 'Nav', pduId: null } }
    })
    const diff = diffImport(
      defaults,
      {
        app: DEFAULT_APP_SETTINGS,
        nodeMapping: cur,
        powerSupply: DEFAULT_PSU,
        calibration: { version: 1, boards: {} }
      },
      { nodeMapping: imp }
    )
    expect(diff[0]!.rows).toEqual([
      { k: 'Right_Navigation', from: 'not in your cockpit', to: 'Nav · Right · —' }
    ])
  })

  it('#95 bug 1 (fixed, S1): an adopted board renamed to its later registry name stays in', () => {
    const left: NodeMappingFile = { version: 4, nodes: { 3: { added: true } } } // PDU_Left (D7)
    const f = adoptNode(
      left,
      defaults,
      41,
      {
        name: 'Left_Oxygen',
        console: 'Left',
        pduId: 3,
        kind: 'panel'
      },
      kinds(left, defaults, { 41: 'panel' })
    )
    const later = registryDefaults({ ...REG, 41: { name: 'Left_Oxy', console: 'Left' } })
    const g = setNodeMapping(f, later, 41, { name: 'Left_Oxy' }, kinds(f, later))
    expect(effectiveMapping(later, g).get(41)?.known).toBe(true)
  })

  it('#95 bug 3 (fixed, S1): a registry panel ID added while reporting PDU reads PDU once silent', () => {
    const f = adoptNode(
      { version: 4, nodes: {} },
      defaults,
      2,
      { name: 'Right_Navigation', console: 'Right', pduId: null, kind: 'pdu' },
      () => 'pdu'
    )
    const m = buildNodeModel({
      roster: [],
      seen: new Map(),
      telemetry: [],
      defaults,
      file: f,
      now: 0
    })
    expect(m.nodes.find((x) => x.nodeId === 2)?.kind).toBe('pdu')
  })
})
