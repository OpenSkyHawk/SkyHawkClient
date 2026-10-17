// X6 / R8: one order for a node's own flags. The Log and every Cockpit surface name a board's flags
// the same way round: bus-off, the fault it reports (degraded), overheat, error-passive.
import { describe, expect, it } from 'vitest'
import type { LogEventInput } from '@shared/events'
import type { NodeStatus } from '@shared/nodes'
import { modelNode, nodeModel, nodeStatus } from '../../test-fixtures/nodes'
import { adoptEvidence } from './cockpit-snapshot/adopt'
import { nodeFaultBoxes } from './cockpit-snapshot/panels'
import { nodeViews } from './cockpit-snapshot/views'
import { NODE_FLAG_ORDER, nodeFlagChips, nodeFlagWords, raisedNodeFlags } from './faults'
import { NodeEventTracker } from './node-events'
import { NODE_END_MSG, NODE_MSG } from './node-status-wire'

const ALL: Partial<NodeStatus> = {
  boff: true,
  degraded: true,
  faultId: 1,
  faultAbbr: 'I2C',
  faultLabel: 'I2C peripheral',
  overheat: true,
  epvf: true,
  tec: 131
}
const st = (over: Partial<NodeStatus> = {}): NodeStatus =>
  nodeStatus(2, { uptimeSec: 130, dieTempC: null, ...over })

/** The rows the Log gets when the board raises `over`, after a healthy baseline. */
function logRows(over: Partial<NodeStatus>): string[] {
  const t = new NodeEventTracker({
    name: () => 'Right_Navigation',
    isNew: () => false,
    unmapped: () => false
  })
  t.status([st()], NODE_MSG, '', 0)
  t.status([st()], NODE_END_MSG, '', 10)
  return t.status([st(over)], NODE_MSG, '', 20).map((e: LogEventInput) => e.event)
}

const view = (over: Partial<NodeStatus>, source: 'registry' | 'new' = 'registry') =>
  nodeViews(nodeModel([modelNode(2, { source, status: st(over), firstSeenAt: 1 })]), [])[0]!

describe('node flag order (X6/R8)', () => {
  it('is the Cockpit’s: bus-off, fault, overheat, error-passive', () => {
    expect(NODE_FLAG_ORDER).toEqual(['boff', 'degraded', 'overheat', 'epvf'])
    expect(raisedNodeFlags(st(ALL))).toEqual(['boff', 'degraded', 'overheat', 'epvf'])
    expect(nodeFlagWords(st(ALL))).toEqual(['bus-off', 'I2C', 'overheat', 'error-passive'])
    expect(nodeFlagChips(st(ALL))).toEqual(['BUS-OFF', 'I2C', 'OVERHEAT', 'ERR-PASSIVE'])
  })

  it('a board with every flag: the Log and the Cockpit name them in the same order', () => {
    expect(logRows(ALL)).toEqual(['bus-off', 'degraded', 'overheat', 'error-passive'])
    expect(nodeFaultBoxes(view(ALL)).map((b) => b.title)).toEqual([
      'Bus-off',
      'I2C peripheral',
      'Overheat',
      'Error-passive'
    ])
    expect(adoptEvidence(view(ALL, 'new')).reporting).toBe(
      'status only · up 00:02:10 · bus-off, I2C, overheat, error-passive'
    )
  })

  it('without bus-off: the tile’s chip, the boxes and the Log agree', () => {
    const { boff: _boff, ...three } = ALL
    expect(logRows(three)).toEqual(['degraded', 'overheat', 'error-passive'])
    expect(view(three).health).toEqual({ state: 'warn', flag: 'I2C · OVERHEAT · ERR-PASSIVE' })
    expect(nodeFaultBoxes(view(three)).map((b) => b.title)).toEqual([
      'I2C peripheral',
      'Overheat',
      'Error-passive'
    ])
  })
})
