import { describe, expect, it } from 'vitest'
import type { NodeStatus } from '@shared/nodes'
import { gatewayStatus } from '../../gateway/gateway-health'
import { nodeStatus } from '../../../test-fixtures/nodes'
import { cockpitAttention } from './attention'

const node0 = (over: Partial<NodeStatus> = {}): NodeStatus =>
  nodeStatus(0, { rxCount: 5, dieTempC: 42, nodeKind: 3, ...over })

/** The Gateway's Attention item alone: no boards, no outages, no strays. */
const item = (g: ReturnType<typeof gatewayStatus>, live = true) =>
  cockpitAttention(undefined, [], [], [], live, g).gateway

describe('the Gateway’s Attention item', () => {
  it('none while healthy or while the link is down', () => {
    expect(item(gatewayStatus(node0(), false))).toBeUndefined()
    expect(item(gatewayStatus(node0({ boff: true }), false), false)).toBeUndefined()
  })

  it('gateway-health.recovered-alone: RECOVERED ITSELF, gold — never off', () => {
    expect(item(gatewayStatus(node0(), false, 're-plug'))).toEqual({
      flag: 'RECOVERED ITSELF',
      state: 'warn'
    })
    expect(item(gatewayStatus(undefined, false, 'recovery'))).toEqual({
      flag: 'RECOVERED ITSELF',
      state: 'warn'
    })
  })

  it('gateway-health.recovered-with-fault: any problem it reports takes the flag', () => {
    expect(item(gatewayStatus(node0({ boff: true }), false, 'recovery'))).toEqual({
      flag: 'Bus-off',
      state: 'off'
    })
    expect(item(gatewayStatus(node0({ epvf: true }), false, 'recovery'))).toEqual({
      flag: 'Error-passive',
      state: 'warn'
    })
  })
})
