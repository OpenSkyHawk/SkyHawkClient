// SESSION-seam tests for "Add all" and "Un-hide all" (#133: R6, N4), through the services harness:
// the renderer's intents in, pushes and node-mapping.json out.
import { describe, expect, it } from 'vitest'
import { CTRL } from '@shared/app'
import type { NodeMappingFile } from '@shared/nodes'
import { statusLine } from '../../test-fixtures/nodes'
import { makeServices } from '../test-harness/services'

const spec = (name: string) => ({ name, console: 'Left', pduId: null, kind: 'panel' }) as const
const mapping = (app: ReturnType<typeof makeServices>) =>
  app.files.json<NodeMappingFile>('node-mapping.json')!.nodes

describe('Add all and Un-hide all (R6, N4)', () => {
  it('a second Add all while the first is still running is ignored: each board is added once', async () => {
    const app = makeServices()
    app.serial.open()
    // Two unlisted panel groups on the bus, waiting to be adopted.
    app.serial.receive(statusLine(41) + statusLine(42) + '_NODE_STATUS_END\n')
    const bulk = [
      { nodeId: 41, spec: spec('Left_A') },
      { nodeId: 42, spec: spec('Left_B') }
    ]
    const before = app.pushesOf('nodes:model').length
    // A double click: the second invoke lands while the first is still adopting.
    const first = app.invoke(CTRL.nodeMappingAddAll, bulk)
    const second = app.invoke(CTRL.nodeMappingAddAll, bulk)
    expect(await second).toEqual({ ok: true, done: [] })
    expect(await first).toEqual({ ok: true, done: [41, 42] })
    // One adopt (and one model push) per board, not two.
    expect(app.pushesOf('nodes:model').length - before).toBe(2)
    expect(mapping(app)[41]).toMatchObject({ added: true, name: 'Left_A' })
    expect(mapping(app)[42]).toMatchObject({ added: true, name: 'Left_B' })
  })

  it('Un-hide all goes on past a board it can’t un-hide and lists it; the others are shown', async () => {
    const app = makeServices({
      paths: {
        files: {
          'node-mapping.json': {
            version: 4,
            nodes: { 1: { added: true, hidden: true }, 2: { added: true, hidden: true } }
          }
        }
      }
    })
    // 999 is no NODE_ID: main refuses it, between the two it can un-hide.
    expect(await app.invoke(CTRL.nodeMappingUnhide, [1, 999, 2])).toEqual({
      ok: false,
      done: [1, 2],
      nodeId: 999,
      error: 'Not a NODE_ID: 999',
      failed: [{ nodeId: 999, error: 'Not a NODE_ID: 999' }]
    })
    expect(mapping(app)).toMatchObject({ 1: { added: true }, 2: { added: true } })
    expect(mapping(app)[1]?.hidden).toBeUndefined()
    expect(mapping(app)[2]?.hidden).toBeUndefined()
    expect(app.lastPush('nodes:model')?.hidden).toEqual([])
  })
})
