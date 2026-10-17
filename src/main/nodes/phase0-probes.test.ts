// Phase-0 behaviour probes (SkyHawkClient#97, arch-phase0-contract PART 1B/1C): each test asserts
// TODAY's behaviour for a fix-track or conflict row, so the structure rewrite can show it changed
// nothing. A fix ticket that changes one of these behaviours on purpose updates its probe.
// Main and shared only; the probes that read renderer helpers are in
// src/renderer/src/phase0-probes.test.ts (main never imports renderer code).
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PSU, type NodeMappingFile } from '@shared/nodes'
import { NODE_END_MSG, NODE_MSG, NodeRoster } from './node-status-wire'
import {
  importMapping,
  setNodeMapping,
  adoptNode,
  effectiveMapping,
  EMPTY_MAPPING
} from './mapping-rules'
import { registryDefaults } from './registry'
import { diffImport, parseConfigFile } from '../config/config-file'
import { CONFIG_FORMAT } from '@shared/config'
import { buildNodeModel } from './node-model'
import { GatewayWatch, GATEWAY_NO_ANSWER_MS } from '../gateway/gateway-health'
import { DEFAULT_APP_SETTINGS } from '../../test-fixtures/config'

const disk: { file: NodeMappingFile } = { file: { version: 3, nodes: {} } }
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
const row = (id: number, kind: number, present = true) =>
  `${id.toString(16).padStart(2, '0')}${present ? '01' : '00'}0000000000000080000000${kind.toString(16).padStart(2, '0')}`.toUpperCase()
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

  it('M1/C3: Forget is accepted while availability is unknown, and for a PDU with fresh telemetry', () => {
    const a = hubWith(added())
    expect(a.h.snapshot(0).model.nodes.find((n) => n.nodeId === 2)?.availability).toBe('unknown')
    expect(a.h.forget(2).ok).toBe(true)
    const b = hubWith(added())
    b.h.telemetry('040100E02E182EBC02', Date.now()) // PDU_Right pages, fresh; not in roster
    expect(b.h.forget(4).ok).toBe(true)
  })

  it('M3: a v2 bridge — END completes the roster, added boards read offline, Forget allowed', () => {
    const a = hubWith(added())
    a.roster.beginBurst(0)
    a.roster.applyMessage(NODE_MSG, '0101000000000000008000', 0) // v2 row (no kind) -> dropped
    a.roster.applyMessage(NODE_END_MSG, '2', 0)
    const n1 = a.h.snapshot(0).model.nodes.find((n) => n.nodeId === 1)
    expect(n1?.availability).toBe('offline')
    expect(a.h.forget(1).ok).toBe(true)
  })

  it('C4: a node identified only by PDU telemetry logs "new on the bus" only at its next status row', () => {
    const a = hubWith({ version: 3, nodes: {} })
    a.status(1, 1, 0)
    a.roster.applyMessage(NODE_END_MSG, '1', 0)
    a.h.statusLine(NODE_END_MSG, '_NODE_STATUS_END 1', 0)
    a.status(9, 0, 2000) // kind 0, never reports a kind
    a.h.telemetry('090100E02E182EBC02', 2500, '_NODE_TELEM 090100E02E182EBC02')
    expect(a.h.snapshot(2500).model.nodes.find((n) => n.nodeId === 9)?.identified).toBe('pdu')
    expect(a.events.filter((e) => e.nodeId === 9 && e.event === 'new on the bus')).toEqual([])
    a.status(9, 0, 7000) // next roster poll row: only now is it news
    expect(a.events.filter((e) => e.nodeId === 9 && e.event === 'new on the bus')).toMatchObject([
      { t: 7000 }
    ])
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

  it('D7: a zone to a registry PDU that is not in your cockpit is accepted by main', () => {
    const f: NodeMappingFile = { version: 3, nodes: { 2: { added: true } } }
    const g = setNodeMapping(f, defaults, 2, { pduId: 3 }) // PDU_Left, not added
    expect(g.nodes[2]).toEqual({ added: true, pduId: 3 })
  })

  it('D3 (fixed, #136): membership is imported as written, and the review lists the join', () => {
    const cur: NodeMappingFile = { version: 3, nodes: {} }
    const imp: NodeMappingFile = { version: 3, nodes: { 2: { added: true, name: 'Nav' } } }
    expect(importMapping(cur, imp)).toEqual({
      version: 3,
      nodes: { 2: { added: true, name: 'Nav' } }
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
      { k: 'Right_Navigation', from: 'not in your cockpit', to: 'Nav · Right · PDU_Right' }
    ])
  })

  it('#95 bug 1: an adopted board renamed to its later registry name drops out', () => {
    const f = adoptNode(EMPTY_MAPPING, defaults, 41, {
      name: 'Left_Oxygen',
      console: 'Left',
      pduId: 3,
      kind: 'panel'
    })
    const later = registryDefaults({ ...REG, 41: { name: 'Left_Oxy', console: 'Left' } })
    const g = setNodeMapping(f, later, 41, { name: 'Left_Oxy' })
    expect(effectiveMapping(later, g).get(41)?.known).toBe(false)
  })

  it('#95 bug 3: a registry panel ID added while reporting PDU reads panel once silent', () => {
    const f = adoptNode(
      { version: 3, nodes: {} },
      defaults,
      2,
      { name: 'Right_Navigation', console: 'Right', pduId: null, kind: 'pdu' },
      () => 'pdu'
    )
    const m = buildNodeModel({ roster: [], seen: new Map(), telemetry: [], defaults, file: f })
    expect(m.nodes.find((x) => x.nodeId === 2)?.kind).toBe('panel')
  })
})
