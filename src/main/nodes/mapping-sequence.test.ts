// "Add all" and "Un-hide all" (R3.2b): the loops the Adopt dialog and Settings ran, one board at a
// time — in order, each awaited before the next, stopping at the first refusal.
import { describe, expect, it, vi } from 'vitest'
import type { NodeMappingResult } from '@shared/nodes'
import { nodeModel } from '../../test-fixtures/nodes'
import { addAllInTurn, unhideInTurn } from './mapping-sequence'

const OK: NodeMappingResult = { ok: true, model: nodeModel([]) }
const spec = { name: 'X', console: 'Left', pduId: null, kind: 'panel' } as const

describe('addAllInTurn', () => {
  it('adopts each in order, the next only once the last has answered', async () => {
    const order: string[] = []
    const adopt = vi.fn(async (id: number) => {
      order.push(`start ${id}`)
      await Promise.resolve()
      order.push(`end ${id}`)
      return OK
    })
    const r = await addAllInTurn(
      [
        { nodeId: 2, spec },
        { nodeId: 7, spec }
      ],
      adopt
    )
    expect(r).toEqual({ ok: true, done: [2, 7] })
    expect(order).toEqual(['start 2', 'end 2', 'start 7', 'end 7'])
  })

  it('stops at the first refusal: the ones before it are done, the rest not tried', async () => {
    const adopt = vi.fn(
      (id: number): NodeMappingResult =>
        id === 7 ? { ok: false, error: 'Name cannot be empty' } : OK
    )
    const r = await addAllInTurn(
      [2, 7, 9].map((nodeId) => ({ nodeId, spec })),
      adopt
    )
    expect(r).toEqual({ ok: false, done: [2], nodeId: 7, error: 'Name cannot be empty' })
    expect(adopt.mock.calls.map(([id]) => id)).toEqual([2, 7])
  })

  it('no answer counts as done, as the dialog read it', async () => {
    expect(await addAllInTurn([{ nodeId: 2, spec }], () => undefined)).toEqual({
      ok: true,
      done: [2]
    })
  })
})

describe('unhideInTurn', () => {
  it('un-hides each in order and stops at the first refusal', async () => {
    const hide = vi.fn(
      (id: number): NodeMappingResult =>
        id === 30 ? { ok: false, error: 'Node mapping is read-only' } : OK
    )
    expect(await unhideInTurn([8, 30, 41], hide)).toEqual({
      ok: false,
      done: [8],
      nodeId: 30,
      error: 'Node mapping is read-only'
    })
    expect(hide.mock.calls).toEqual([
      [8, false],
      [30, false]
    ])
    expect(await unhideInTurn([8], hide)).toEqual({ ok: true, done: [8] })
  })
})
