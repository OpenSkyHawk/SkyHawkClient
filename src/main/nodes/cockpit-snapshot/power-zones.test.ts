// D7 / R1 / X4 and X7 (#131): one resolved power zone per board — `active`, `hidden` or `none` —
// read by every surface the snapshot builds, and one fed-boards rule (Feeds and Forget count hidden
// boards; an outage counts only the ones that could have dropped with the PDU). Built from a real
// node-mapping file through the model, so main's own rules are what is tested.
import { describe, expect, it } from 'vitest'
import type { NodeMappingFile, NodeSeen } from '@shared/nodes'
import { hhmmss } from '@shared/format'
import { nodeStatus } from '../../../test-fixtures/nodes'
import { registryDefaults } from '../registry'
import { buildNodeModel } from '../node-model'
import { resolveZone, zoneLabel, type ZoneMember } from '../power-zone'
import { buildCockpitSnapshot } from '.'

const defaults = registryDefaults({
  1: { name: 'Center_Armament', console: 'Center' }, // → PDU_Center (5)
  2: { name: 'Right_Navigation', console: 'Right' }, // → PDU_Right (4)
  3: { name: 'PDU_Left', console: 'Left' },
  4: { name: 'PDU_Right', console: 'Right' },
  5: { name: 'PDU_Center', console: 'Center' },
  6: { name: 'Left_Oxygen', console: 'Left' }, // → PDU_Left (3)
  7: { name: 'Right_TACAN', console: 'Right' }, // → PDU_Right (4)
  8: { name: 'Center_Clock', console: 'Center' }, // → PDU_Center (5)
  9: { name: 'Left_Lights', console: 'Left' } // → PDU_Left (3)
})

const T = Date.UTC(2026, 9, 17, 10, 0, 0)
const SEEN = '2026-10-14T21:14:00.000Z'

/**
 * In your cockpit: PDU_Right (4, offline), PDU_Left (3, hidden), Right_Navigation (2, under
 * PDU_Right), Left_Oxygen (6, under the hidden PDU_Left), Center_Armament (1: its PDU_Center was
 * never added) and Right_TACAN (7, hidden, under PDU_Right). On the bus, not added yet:
 * Center_Clock (8) and Left_Lights (9), both panel groups.
 */
const file: NodeMappingFile = {
  version: 4,
  nodes: {
    1: { added: true, lastSeen: SEEN },
    2: { added: true, lastSeen: SEEN },
    3: { added: true, hidden: true, lastSeen: SEEN },
    4: { added: true, lastSeen: SEEN },
    6: { added: true, lastSeen: SEEN },
    7: { added: true, hidden: true, lastSeen: SEEN }
  }
}
const off: NodeSeen = { firstSeenAt: 0, offlineAt: T, offlineVia: 'delta' }
const panel = (id: number, present = true) =>
  nodeStatus(id, { present, nodeKind: 1, uptimeSec: 0, rxCount: 0, dieTempC: null })
const model = buildNodeModel({
  roster: [
    panel(1, false),
    panel(2, false),
    { ...panel(4, false), nodeKind: 2 },
    panel(6, false),
    panel(8),
    panel(9)
  ],
  seen: new Map([
    [1, off],
    [2, off],
    [4, off],
    [6, off],
    [8, { firstSeenAt: T }],
    [9, { firstSeenAt: T + 1 }]
  ]),
  rosterCompleteAt: T,
  telemetry: [],
  defaults,
  file
})
const { snapshot: snap } = buildCockpitSnapshot({
  model,
  telemetry: [],
  device: { state: 'connected' },
  peakW: 0,
  now: T,
  rev: 1
})

describe('resolveZone / zoneLabel', () => {
  const members: Record<number, ZoneMember> = {
    3: { nodeId: 3, name: 'PDU_Left', kind: 'pdu', hidden: true },
    4: { nodeId: 4, name: 'PDU_Right', kind: 'pdu', hidden: false },
    2: { nodeId: 2, name: 'Right_Navigation', kind: 'panel', hidden: false }
  }
  const member = (id: number): ZoneMember | undefined => members[id]

  it('active, hidden or none — a zone is only a PDU in your cockpit', () => {
    expect(resolveZone(member, 4)).toEqual({
      status: 'active',
      pduId: 4,
      name: 'PDU_Right',
      label: 'PDU_Right'
    })
    expect(resolveZone(member, 3)).toEqual({
      status: 'hidden',
      pduId: 3,
      name: 'PDU_Left',
      label: 'PDU_Left (hidden)'
    })
    expect(resolveZone(member, 5)).toEqual({ status: 'none' }) // not in your cockpit
    expect(resolveZone(member, 2)).toEqual({ status: 'none' }) // a panel
    expect(resolveZone(member, null)).toEqual({ status: 'none' })
  })

  it('labels a hidden PDU "(hidden)", in a picker with "other console" too', () => {
    expect(zoneLabel('PDU_Right', false)).toBe('PDU_Right')
    expect(zoneLabel('PDU_Right', true)).toBe('PDU_Right (hidden)')
    expect(zoneLabel('PDU_Right', false, true)).toBe('PDU_Right (other console)')
    expect(zoneLabel('PDU_Right', true, true)).toBe('PDU_Right (hidden, other console)')
  })
})

describe('one resolved zone, read by every surface (D7 / R1)', () => {
  it('the model: only a PDU in your cockpit, hidden ones included', () => {
    const pduOf = (id: number) => model.nodes.find((n) => n.nodeId === id)?.pduId
    expect([1, 2, 6].map(pduOf)).toEqual([null, 4, 3])
  })

  it('the plan: under its PDU while active; a hidden or no zone sits in its console’s No power zone', () => {
    const groups = Object.fromEntries(
      snap.plan.map((pc) => [
        pc.key,
        pc.zones.map((z) => [z.key, z.members.map((m) => m.entry.nodeId)])
      ])
    )
    expect(groups).toEqual({
      L: [['none-L', [6]]], // fed by the hidden PDU_Left: the link is kept, off the plan (B10)
      C: [['none-C', [1]]],
      R: [['pdu-4', [2]]]
    })
  })

  it('Powered by: each panel carries its resolved zone', () => {
    expect(snap.panels[2]?.zone).toEqual({
      status: 'active',
      pduId: 4,
      name: 'PDU_Right',
      label: 'PDU_Right'
    })
    expect(snap.panels[6]?.zone).toEqual({
      status: 'hidden',
      pduId: 3,
      name: 'PDU_Left',
      label: 'PDU_Left (hidden)'
    })
    expect(snap.panels[1]?.zone).toEqual({ status: 'none' })
  })

  it('Connected nodes names the same zone', () => {
    const meta = Object.fromEntries(snap.nodesCard.rows.map((r) => [r.nodeId, r.meta]))
    expect(meta[6]).toBe(`#6 · PDU_Left (hidden) · offline since ${hhmmss(T)}`)
    expect(meta[1]).toBe(`#1 · no power zone · offline since ${hhmmss(T)}`)
  })

  it('Adopt: the pre-fill and Add all keep the default PDU only if it is in your cockpit', () => {
    const row = (id: number) => snap.adopt.find((r) => r.view.entry.nodeId === id)!
    expect([row(8).prefill.pduId, row(8).addAllPduId]).toEqual([null, null]) // PDU_Center: not added
    expect([row(9).prefill.pduId, row(9).addAllPduId]).toEqual([3, 3]) // PDU_Left: hidden, in
  })

  it('the zone pickers offer only PDUs in your cockpit, a hidden one marked', () => {
    expect(snap.zones.options['Left']?.['']).toEqual([{ value: 3, label: 'PDU_Left (hidden)' }])
    expect(snap.zones.options['Right']?.['']).toEqual([{ value: 4, label: 'PDU_Right' }])
    expect(snap.zones.options['Center']?.['']).toEqual([]) // PDU_Center is not in your cockpit
    expect(snap.zones).not.toHaveProperty('first') // N9: a console change clears the zone
  })
})

describe('one fed-boards rule (X7)', () => {
  it('Feeds and the Forget note count hidden boards; the outage counts only the ones on the plan', () => {
    const p = snap.panels[4]!
    expect(p.feeds).toEqual([
      { nodeId: 2, name: 'Right_Navigation', detail: 'OFFLINE', hidden: false },
      {
        nodeId: 7,
        name: 'Right_TACAN',
        detail: 'hidden until it reports again',
        hidden: true
      }
    ])
    expect(p.actions.note).toMatch(/^Forget removes this PDU from your cockpit\. Its 2 boards /)
    // Right_TACAN is hidden: it could not have dropped with PDU_Right.
    expect(snap.outages).toEqual([{ pduId: 4, nodeIds: [2], fedCount: 1, at: T }])
  })
})
