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
import { adoptRows } from '../../../main/nodes/cockpit-snapshot/adopt'
import { cockpitMembers } from '../../../main/nodes/cockpit-snapshot/members'
import { boardZones } from '../../../main/nodes/power-zone'
import { nodeFaultBoxes, powerZoneOptions } from '../../../main/nodes/cockpit-snapshot/panels'
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
  `${id.toString(16).padStart(2, '0')}${present ? '01' : '00'}0000000000000080000000${kind.toString(16).padStart(2, '0')}0000000000`.toUpperCase()

describe('fix-track probes (today)', () => {
  it('D1 (fixed, #133 X3): one stray is a warning on the Cockpit, the Overview and Connection alike', () => {
    const roster = new NodeRoster()
    roster.applyMessage(NODE_MSG, row(9, 0), 0)
    const model = buildNodeModel({
      roster: roster.snapshot(),
      seen: roster.seenInfo(),
      rosterCompleteAt: 0,
      telemetry: [],
      now: 0,
      defaults,
      file: EMPTY_MAPPING
    })
    const views = nodeViews(model, [])
    const cockpit = cockpitViews(model, [])
    const { strays } = strayNew(cockpit, 6000, true)
    expect(strays).toHaveLength(1)
    const items = [{ nodeId: 9, flag: 'UNIDENTIFIED · can’t be adopted' }]
    const cockpitBand = cockpitHealthBand(cockpit, strays.length)
    expect(cockpitBand.warn).toBe(1)
    expect(cockpitAttentionItems(cockpit, [], items)).toHaveLength(1)
    // Overview: the same band and items (was: "no nodes known", no banner)
    const ovBand = healthBand(views, strays.length)
    expect(cockpitTile(ovBand, true)).toMatchObject({ value: '1 / 1', symbol: 'warn' })
    expect(attentionSummary(ovBand, attentionItems(views, [], items))).toEqual({
      head: '1 node needs attention',
      detail: '1 warning (NODE_ID 9)'
    })
    expect(newDevices(views, true)).toBeNull() // a stray is not news
    // Connection (was: known 0, warn 0, no rows)
    expect(
      nodesSummary(views, [], items, boardZones(model.nodes, cockpitMembers(model).get), true)
    ).toMatchObject({ known: 1, warn: 1, rows: [{ nodeId: 9, state: 'warn' }] })
  })

  it('S6 (fixed, #133): grace counts from coming online — a board seen absent, online late, waits 5 s', () => {
    const roster = new NodeRoster()
    roster.applyMessage(NODE_MSG, row(9, 0, false), 0)
    roster.applyMessage(NODE_MSG, row(9, 0, true), 60_000)
    const model = buildNodeModel({
      roster: roster.snapshot(),
      seen: roster.seenInfo(),
      rosterCompleteAt: 0,
      telemetry: [],
      now: 0,
      defaults,
      file: EMPTY_MAPPING
    })
    // Was: a stray at once (60 001), the grace counted from the absent row at 0.
    expect(strayNew(cockpitViews(model, []), 60_001, true)).toEqual({ strays: [], nextAt: 65_000 })
    expect(strayNew(cockpitViews(model, []), 65_000, true).strays).toHaveLength(1)
  })

  it('C6 (fixed, #133 X8): a registry board waiting to be added is "from NODE_IDS.md" everywhere', () => {
    const roster = new NodeRoster()
    roster.applyMessage(NODE_MSG, row(2, 1), 0)
    const model = buildNodeModel({
      roster: roster.snapshot(),
      seen: roster.seenInfo(),
      rosterCompleteAt: 0,
      telemetry: [],
      now: 0,
      defaults,
      file: EMPTY_MAPPING
    })
    const e = model.nodes.find((n) => n.nodeId === 2)!
    expect(e.registry?.name).toBe('Right_Navigation')
    // Was: the registry wording, in capitals and as a title (main phase0-probes X8 probe).
    expect(cockpitNodeHealth(e).flag).toBe('FROM NODE_IDS.md')
    expect(
      nodeFaultBoxes(cockpitViews(model, []).find((v) => v.entry.nodeId === 2)!)[0]!.title
    ).toBe('From NODE_IDS.md')
  })

  it('#95 bug 2 (fixed, #131 X1): a hidden in-cockpit PDU is in your cockpit to Add all and the PDU choices', () => {
    let f: NodeMappingFile = { version: 4, nodes: { 5: { added: true } } }
    f = setHidden(f, defaults, 5, true)
    const roster = new NodeRoster()
    roster.applyMessage(NODE_MSG, row(1, 1), 0)
    const m = buildNodeModel({
      roster: roster.snapshot(),
      seen: roster.seenInfo(),
      rosterCompleteAt: 0,
      telemetry: [],
      now: 0,
      defaults,
      file: f
    })
    const views = cockpitViews(m, [])
    const members = cockpitMembers(m)
    expect(registrySpecs(adoptRows(views, members))[0]?.spec.pduId).toBe(5)
    // The one Powered by list (D7, #131): a hidden PDU is offered, marked "(hidden)".
    expect(powerZoneOptions(members, 'Center', 5)).toEqual([
      { value: 5, label: 'PDU_Center (hidden)' }
    ])
  })
})
