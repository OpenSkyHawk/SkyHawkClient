// D6 / R3 (#131): where clicking a board goes, decided once in main from the one membership. A
// board in your cockpit (hidden ones included) opens its panel; every other NODE_ID opens the Adopt
// dialog on it — never a board panel. Built from a real node-mapping file through the model, so
// main's own membership rule is what is tested.
import { describe, expect, it } from 'vitest'
import type { NodeMappingFile } from '@shared/nodes'
import { NODE_KINDS } from '@shared/firmware'
import { nodeStatus } from '../../../test-fixtures/nodes'
import { registryDefaults } from '../registry'
import { buildNodeModel } from '../node-model'
import { buildCockpitSnapshot } from '.'

const defaults = registryDefaults({
  1: { name: 'Center_Armament', console: 'Center' },
  3: { name: 'PDU_Left', console: 'Left' },
  4: { name: 'PDU_Right', console: 'Right' },
  6: { name: 'Left_Oxygen', console: 'Left' }
})

const T = Date.UTC(2026, 9, 17, 10, 0, 0)
const SEEN = '2026-10-14T21:14:00.000Z'

/**
 * In your cockpit: Center_Armament (1, online), PDU_Left (3, hidden, off the bus), an adopted
 * panel group (20, online) and Left_Oxygen (6, offline). On the bus, not in your cockpit: PDU_Right
 * (4, NODE_IDS.md, not added yet), an unlisted panel group (21), one still identifying (22), a
 * second Gateway (23) and a board type this client doesn't know (24).
 */
const file: NodeMappingFile = {
  version: 4,
  nodes: {
    1: { added: true, lastSeen: SEEN },
    3: { added: true, hidden: true, lastSeen: SEEN },
    6: { added: true, lastSeen: SEEN },
    20: { added: true, name: 'Rig_Panel', console: 'Left', kind: 'panel', lastSeen: SEEN }
  }
}
const row = (id: number, nodeKind: number, present = true) => nodeStatus(id, { present, nodeKind })

function snapshotOf(f: NodeMappingFile) {
  const model = buildNodeModel({
    roster: [
      row(1, NODE_KINDS.PANEL_GROUP),
      row(4, NODE_KINDS.PDU),
      row(6, NODE_KINDS.PANEL_GROUP, false),
      row(20, NODE_KINDS.PANEL_GROUP),
      row(21, NODE_KINDS.PANEL_GROUP),
      row(22, 0),
      row(23, NODE_KINDS.BRIDGE),
      row(24, 99)
    ],
    seen: new Map([1, 4, 6, 20, 21, 22, 23, 24].map((id) => [id, { firstSeenAt: T }])),
    rosterCompleteAt: T,
    telemetry: [],
    defaults,
    file: f
  })
  return buildCockpitSnapshot({
    model,
    telemetry: [],
    device: { state: 'connected' },
    peakW: 0,
    now: T,
    rev: 1
  }).snapshot
}

describe('boardOpens: where clicking a board goes (D6)', () => {
  it('a board in your cockpit opens its panel; every other NODE_ID opens Adopt on it', () => {
    expect(snapshotOf(file).opens).toEqual({
      1: 'panel',
      3: 'panel',
      4: 'adopt',
      6: 'panel',
      20: 'panel',
      21: 'adopt',
      22: 'adopt',
      23: 'adopt',
      24: 'adopt'
    })
  })

  it('a hidden board is in your cockpit, so it routes to its panel, never to Adopt', () => {
    const snap = snapshotOf(file)
    expect(snap.views.map((v) => v.entry.nodeId)).not.toContain(3)
    expect(snap.opens[3]).toBe('panel')
  })

  it('every board Adopt would open on is in its queue, and no board it lists opens a panel', () => {
    const snap = snapshotOf(file)
    const queued = snap.adopt.map((r) => r.view.entry.nodeId)
    const toAdopt = Object.entries(snap.opens)
      .filter(([, to]) => to === 'adopt')
      .map(([id]) => Number(id))
    expect(toAdopt).toEqual(queued.slice().sort((a, b) => a - b))
  })

  it('only a board in your cockpit on the plan has a panel; none for a board outside it', () => {
    const snap = snapshotOf(file)
    expect(Object.keys(snap.panels).map(Number)).toEqual([1, 6, 20])
    for (const [id, to] of Object.entries(snap.opens)) {
      if (to === 'adopt') expect(snap.panels[Number(id)]).toBeUndefined()
    }
  })

  it('forgetting a board on the bus moves it from its panel to Adopt', () => {
    const forgotten: NodeMappingFile = {
      version: 4,
      nodes: { ...file.nodes, 1: { lastSeen: SEEN }, 20: { lastSeen: SEEN } }
    }
    const snap = snapshotOf(forgotten)
    expect(snap.opens[1]).toBe('adopt')
    expect(snap.opens[20]).toBe('adopt')
    expect(snap.panels[1]).toBeUndefined()
    expect(snap.panels[20]).toBeUndefined()
  })

  it('nothing opens before the first model', () => {
    expect(
      buildCockpitSnapshot({
        telemetry: [],
        device: { state: 'connected' },
        peakW: 0,
        now: T,
        rev: 1
      }).snapshot.opens
    ).toEqual({})
  })
})
