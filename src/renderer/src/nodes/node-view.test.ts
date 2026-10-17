// The Cockpit's board symbols and search box (node-view.ts; from cockpit.test.ts, R3.2), and the
// symbols Connection's rows draw (from connection-summary.test.ts, R3.2b).
import { describe, expect, it } from 'vitest'
import type { NodeModelEntry, NodeTelemSnapshot, PduOutage } from '@shared/nodes'
import {
  modelNode as node,
  nodeModel as model,
  nodeStatus as status
} from '../../../test-fixtures/nodes'
import { attentionItems } from '../../../main/nodes/cockpit-snapshot/attention'
import { nodesSummary } from '../../../main/nodes/cockpit-snapshot/summaries'
import { cockpitMembers } from '../../../main/nodes/cockpit-snapshot/members'
import { boardZones } from '../../../main/nodes/power-zone'
import { nodeViews } from '../../../main/nodes/cockpit-snapshot/views'
import { STATE_SYMBOL, tileMatches } from './node-view'

describe('nodeHealth', () => {
  it('maps every state to a symbol, healthy and unknown to none', () => {
    expect(STATE_SYMBOL).toEqual({ on: '', warn: '!', off: '✕', new: '+', unknown: '' })
  })
})

describe('tileMatches', () => {
  const [ok, bad] = nodeViews(
    model([
      node(1, { name: 'Center_Armament' }),
      node(2, { name: 'Right_Navigation', availability: 'offline' })
    ]),
    []
  )

  it('matches name (case-insensitive) or NODE_ID, with or without #', () => {
    expect(tileMatches(ok!, 'armam', false)).toBe(true)
    expect(tileMatches(ok!, '#1', false)).toBe(true)
    expect(tileMatches(ok!, '1', false)).toBe(true)
    expect(tileMatches(ok!, 'nav', false)).toBe(false)
  })

  it('Issues keeps only nodes with a problem', () => {
    expect(tileMatches(ok!, '', true)).toBe(false)
    expect(tileMatches(bad!, '', true)).toBe(true)
  })
})

const summary = (
  nodes: NodeModelEntry[],
  outages: PduOutage[] = [],
  telemetry: NodeTelemSnapshot[] = []
) => {
  const m = model(nodes, outages)
  return nodesSummary(
    nodeViews(m, telemetry),
    outages,
    boardZones(m.nodes, cockpitMembers(m).get),
    true
  )
}

const T = 1_760_000_000_000

describe('nodesSummary rows', () => {
  it('shows the 3 most severe in Cockpit Attention order, with symbols', () => {
    const nodes = [
      node(1, { status: status(1, { epvf: true }) }),
      node(2, { availability: 'offline', offlineAt: T }),
      node(9, { status: status(9, { boff: true }) }),
      node(10, { status: status(10, { overheat: true }) }),
      node(11)
    ]
    const s = summary(nodes)
    const att = attentionItems(nodeViews(model(nodes), []), [])
    expect(s.rows.map((r) => r.nodeId)).toEqual(att.slice(0, 3).map((i) => i.nodeId))
    expect(s.rows.map((r) => [r.nodeId, r.chip, r.tone, STATE_SYMBOL[r.state]])).toEqual([
      [2, 'OFFLINE', 'err', '✕'],
      [9, 'BUS-OFF', 'err', '✕'],
      [1, 'ERR-PASSIVE', 'warn', '!']
    ])
    expect(s.more).toBe(1)
    expect(s.footer).toBe('+1 more · healthy nodes hidden')
  })
})
