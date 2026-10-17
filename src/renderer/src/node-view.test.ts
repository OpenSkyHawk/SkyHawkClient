// The Cockpit's board symbols and search box (node-view.ts; from cockpit.test.ts, R3.2).
import { describe, expect, it } from 'vitest'
import { modelNode as node, nodeModel as model } from '../../test-fixtures/nodes'
import { nodeViews } from '../../main/nodes/cockpit-snapshot/views'
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
