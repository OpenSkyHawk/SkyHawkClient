// "Add all" and "Un-hide all" (R3.2b): the loops the Adopt dialog and Settings ran, one board at a
// time — in order, each awaited before the next. Add all stops at the first refusal; Un-hide all
// goes on and lists every refusal (N4); neither re-enters (R6).
import { describe, expect, it, vi } from 'vitest'
import type { NodeMappingResult } from '@shared/nodes'
import { nodeModel } from '../../test-fixtures/nodes'
import { addAllInTurn, MappingSequences, unhideInTurn } from './mapping-sequence'

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
    expect(r).toEqual({
      ok: false,
      done: [2],
      nodeId: 7,
      error: 'Name cannot be empty',
      failed: [{ nodeId: 7, error: 'Name cannot be empty' }]
    })
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
  // N4 (#133): it used to stop at the first refusal, with no word about the rest.
  it('un-hides each in order, goes on past a refusal and lists every one refused', async () => {
    const hide = vi.fn(
      (id: number): NodeMappingResult =>
        id === 30 || id === 52 ? { ok: false, error: `#${id} could not be saved` } : OK
    )
    expect(await unhideInTurn([8, 30, 41, 52], hide)).toEqual({
      ok: false,
      done: [8, 41],
      nodeId: 30,
      error: '#30 could not be saved',
      failed: [
        { nodeId: 30, error: '#30 could not be saved' },
        { nodeId: 52, error: '#52 could not be saved' }
      ]
    })
    expect(hide.mock.calls).toEqual([
      [8, false],
      [30, false],
      [41, false],
      [52, false]
    ])
    expect(await unhideInTurn([8], hide)).toEqual({ ok: true, done: [8] })
  })
})

describe('MappingSequences (R6: no re-entry)', () => {
  /** An answer the test releases, so the first call is still running when the second comes. */
  function gate() {
    let open!: () => void
    const p = new Promise<NodeMappingResult>((r) => (open = () => r(OK)))
    return { p, open }
  }

  it('a second Add all while the first runs is ignored, not run twice', async () => {
    const seq = new MappingSequences()
    const g = gate()
    const adopt = vi.fn((_id: number) => g.p)
    const bulk = [2, 7].map((nodeId) => ({ nodeId, spec }))
    const first = seq.addAll(bulk, adopt)
    const second = await seq.addAll(bulk, adopt)
    expect(second).toEqual({ ok: true, done: [] })
    g.open()
    expect(await first).toEqual({ ok: true, done: [2, 7] })
    expect(adopt.mock.calls.map(([id]) => id)).toEqual([2, 7])
    // Once it has finished, it runs again.
    expect(await seq.addAll(bulk, () => OK)).toEqual({ ok: true, done: [2, 7] })
  })

  it('a second Un-hide all while the first runs is ignored; a refusal still frees it', async () => {
    const seq = new MappingSequences()
    const g = gate()
    const hide = vi.fn(() => g.p)
    const first = seq.unhide([8, 30], hide)
    expect(await seq.unhide([8, 30], hide)).toEqual({ ok: true, done: [] })
    g.open()
    expect(await first).toEqual({ ok: true, done: [8, 30] })
    expect(hide).toHaveBeenCalledTimes(2)
    const refused = await seq.unhide([8], () => ({ ok: false, error: 'read-only' }))
    expect(refused.ok).toBe(false)
    expect(await seq.unhide([8], () => OK)).toEqual({ ok: true, done: [8] })
  })

  it('Add all and Un-hide all are separate: one running doesn’t block the other', async () => {
    const seq = new MappingSequences()
    const g = gate()
    const first = seq.addAll([{ nodeId: 2, spec }], () => g.p)
    expect(await seq.unhide([8], () => OK)).toEqual({ ok: true, done: [8] })
    g.open()
    expect(await first).toEqual({ ok: true, done: [2] })
  })
})
