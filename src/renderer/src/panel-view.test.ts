// The side panels' presentation (panel-view.ts; from cockpit-panels.test.ts, R3.2): the report age
// clock and the patch Save sends. What a panel says and offers moved to main with its tests.
import { describe, expect, it } from 'vitest'
import type { NodeModelEntry, NodeStatus } from '@shared/nodes'
import { modelNode, nodeStatus } from '../../test-fixtures/nodes'
import { mappingPatch, reportAge } from './panel-view'

const status = (nodeId: number, over: Partial<NodeStatus> = {}): NodeStatus =>
  nodeStatus(nodeId, { uptimeSec: 3725, rxCount: 12345, tec: 8, rec: 1, dieTempC: 33, ...over })

const node = (nodeId: number, over: Partial<NodeModelEntry> = {}): NodeModelEntry =>
  modelNode(nodeId, { status: status(nodeId), ...over })

const pdu = (nodeId: number, console: string, over: Partial<NodeModelEntry> = {}) =>
  node(nodeId, {
    name: `PDU_${console}`,
    console,
    kind: 'pdu',
    readings: 'live',
    everHadReadings: true,
    ...over
  })

describe('reportAge', () => {
  it('ticks between the bridge’s 5 s reports, and says when it stopped', () => {
    const e = node(1, { reportedAt: 10_000 })
    expect(reportAge(e, 13_400)).toBe('updated 3 s ago')
    expect(reportAge(e, 130_000)).toBe('updated 2 min ago')
    expect(reportAge({ ...e, availability: 'offline' }, 40_000)).toBe('last report 30 s ago')
    expect(reportAge(node(1), 40_000)).toBe('') // never reported this session
  })
})

describe('placement', () => {
  it('Save sends only what changed', () => {
    const e = node(1, { name: 'Center_Armament', console: 'Center', pduId: 5 })
    expect(mappingPatch(e, { name: 'Center_Armament ', console: 'Center', pduId: 5 })).toEqual({})
    expect(mappingPatch(e, { name: 'Arm', console: 'Left', pduId: 3 })).toEqual({
      name: 'Arm',
      console: 'Left',
      pduId: 3
    })
    expect(mappingPatch(e, { name: 'Center_Armament', console: 'Center', pduId: null })).toEqual({
      pduId: null
    })
  })

  it('a PDU renames and moves console, never takes a power zone (#93)', () => {
    const p = pdu(3, 'Left')
    expect(mappingPatch(p, { name: 'PDU_Port', console: 'Right', pduId: 4 })).toEqual({
      name: 'PDU_Port',
      console: 'Right'
    })
    expect(mappingPatch(p, { name: p.name, console: 'Left', pduId: 4 })).toEqual({})
  })
})
