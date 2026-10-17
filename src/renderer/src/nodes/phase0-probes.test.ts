// Phase-0 behaviour probes (SkyHawkClient#97, arch-phase0-contract PART 1B/1C), the renderer half:
// each test asserts TODAY's behaviour for a conflict or fix-track row that the renderer helpers
// decide, so the structure rewrite can show it changed nothing. A fix ticket that changes one of
// these behaviours on purpose updates its probe. The main/shared half is
// src/main/nodes/phase0-probes.test.ts.
import { describe, expect, it } from 'vitest'
import type { NodeMappingFile } from '@shared/nodes'
import { NODE_MSG, NodeRoster } from '../../../main/nodes/node-status-wire'
import { setHidden, EMPTY_MAPPING } from '../../../main/nodes/mapping-rules'
import { registryDefaults } from '../../../main/nodes/registry'
import { buildNodeModel } from '../../../main/nodes/node-model'
// Built in main since R3.2 (cockpit-snapshot): the Cockpit's half, and since R3.2b the Overview's
// and Connection's (summaries.ts), each surface with its own variant.
import {
  nodeViews,
  nodeViews as cockpitViews,
  nodeHealth as cockpitNodeHealth
} from '../../../main/nodes/cockpit-snapshot/views'
import {
  healthBand,
  healthBand as cockpitHealthBand
} from '../../../main/nodes/cockpit-snapshot/band'
import {
  attentionItems,
  attentionItems as cockpitAttentionItems,
  strayNew
} from '../../../main/nodes/cockpit-snapshot/attention'
import { adoptPduChoices, adoptRows } from '../../../main/nodes/cockpit-snapshot/adopt'
import { nodeFaultBoxes } from '../../../main/nodes/cockpit-snapshot/panels'
import { registrySpecs } from './adopt-view'
import {
  cockpitTile,
  attentionSummary,
  newDevices,
  nodesSummary
} from '../../../main/nodes/cockpit-snapshot/summaries'

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

describe('fix-track probes (today)', () => {
  it('D1 conflict: one stray is a Cockpit warning but Overview/Connection see nothing', () => {
    const roster = new NodeRoster()
    roster.applyMessage(NODE_MSG, row(9, 0), 0)
    const model = buildNodeModel({
      roster: roster.snapshot(),
      seen: roster.seenInfo(),
      rosterCompleteAt: 0,
      telemetry: [],
      defaults,
      file: EMPTY_MAPPING
    })
    const views = nodeViews(model, [])
    const cockpit = cockpitViews(model, [])
    const { strays } = strayNew(cockpit, 6000)
    expect(strays).toHaveLength(1)
    const cockpitBand = cockpitHealthBand(cockpit, strays.length)
    expect(cockpitBand.warn).toBe(1)
    expect(
      cockpitAttentionItems(cockpit, [], [{ nodeId: 9, flag: 'UNIDENTIFIED · can’t be adopted' }])
    ).toHaveLength(1)
    // Overview
    const ovBand = healthBand(views)
    expect(cockpitTile(ovBand, true)).toMatchObject({ value: '—', sub: 'no nodes known' })
    expect(attentionSummary(ovBand, attentionItems(views, []))).toBeNull()
    expect(newDevices(views, true)).toBeNull()
    // Connection
    expect(nodesSummary(views, [])).toMatchObject({ known: 0, warn: 0, rows: [] })
  })

  it('S6: grace counts from first sighting — a board seen absent then online late is a stray at once', () => {
    const roster = new NodeRoster()
    roster.applyMessage(NODE_MSG, row(9, 0, false), 0)
    roster.applyMessage(NODE_MSG, row(9, 0, true), 60_000)
    const model = buildNodeModel({
      roster: roster.snapshot(),
      seen: roster.seenInfo(),
      rosterCompleteAt: 0,
      telemetry: [],
      defaults,
      file: EMPTY_MAPPING
    })
    expect(strayNew(cockpitViews(model, []), 60_001).strays).toHaveLength(1)
  })

  it('C6: a registry board waiting to be added is labelled "NOT IN REGISTRY" / "Not in registry"', () => {
    const roster = new NodeRoster()
    roster.applyMessage(NODE_MSG, row(2, 1), 0)
    const model = buildNodeModel({
      roster: roster.snapshot(),
      seen: roster.seenInfo(),
      rosterCompleteAt: 0,
      telemetry: [],
      defaults,
      file: EMPTY_MAPPING
    })
    const e = model.nodes.find((n) => n.nodeId === 2)!
    expect(e.registry?.name).toBe('Right_Navigation')
    expect(cockpitNodeHealth(e).flag).toBe('NOT IN REGISTRY')
    expect(
      nodeFaultBoxes(cockpitViews(model, []).find((v) => v.entry.nodeId === 2)!)[0]!.title
    ).toBe('Not in registry')
  })

  it('#95 bug 2: a hidden in-cockpit PDU is "(not added)" to Add all and the PDU choices', () => {
    let f: NodeMappingFile = { version: 3, nodes: { 5: { added: true } } }
    f = setHidden(f, defaults, 5, true)
    const roster = new NodeRoster()
    roster.applyMessage(NODE_MSG, row(1, 1), 0)
    const m = buildNodeModel({
      roster: roster.snapshot(),
      seen: roster.seenInfo(),
      rosterCompleteAt: 0,
      telemetry: [],
      defaults,
      file: f
    })
    const views = cockpitViews(m, [])
    expect(registrySpecs(adoptRows(views))[0]?.spec.pduId).toBeNull()
    expect(adoptPduChoices(views, 'Center', 5, m.nodes.find((n) => n.nodeId === 1)!).pending).toBe(
      'PDU_Center'
    )
  })
})
