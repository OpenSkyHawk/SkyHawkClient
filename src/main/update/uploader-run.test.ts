// The uploader run every target shares (#187, #175): its phases as the dialog's steps, the retry
// note, and what a result says was left behind.
import { describe, expect, it } from 'vitest'
import type { UplPhaseName } from '@shared/firmware'
import type { UpdateNote, UpdateStepKey } from '@shared/update'
import { FlashWatch, UploaderRun } from './uploader-run'
import type { UplOutcome, UplStatus } from './uploader/upl-codec'
import type { UploaderClient } from './uploader/uploader-client'

const STEPS: readonly UpdateStepKey[] = ['stage', 'boot', 'write', 'verify', 'restart', 'ver']

function watched() {
  const seen = {
    steps: [] as number[],
    pct: [] as number[],
    notes: [] as (UpdateNote | undefined)[]
  }
  const watch = new FlashWatch(
    { steps: () => STEPS },
    {
      step: (i) => seen.steps.push(i),
      pct: (n) => seen.pct.push(n),
      note: (n) => seen.notes.push(n)
    }
  )
  const status = (phase: UplPhaseName, extra: Partial<UplStatus> = {}) =>
    watch.status({ phase, target: 3, attempt: 0, block: 0, blocks: 0, ...extra } as UplStatus)
  return { watch, seen, status }
}

describe('uploader run: statuses as steps', () => {
  it('maps each phase to its step and fills writing from block / blocks', () => {
    const { watch, seen, status } = watched()
    status('ENTERING_BOOT')
    status('CONNECTED')
    status('ERASING')
    status('WRITING', { block: 258, blocks: 517 })
    status('WRITING', { block: 517, blocks: 517 })
    status('VERIFYING')
    status('REBOOTING')
    status('CONFIRMING')
    expect(seen.steps).toEqual([1, 2, 3, 4, 5])
    expect(seen.pct).toEqual([50, 100])
    expect(watch.erased).toBe(true)
    expect(seen.notes).toEqual([])
  })

  it('a retry is a note, never a step back; then recovered once its write is through', () => {
    const { watch, seen, status } = watched()
    status('WRITING', { block: 300, blocks: 517 })
    status('ENTERING_BOOT', { attempt: 1 })
    status('WRITING', { attempt: 1, block: 100, blocks: 517 })
    status('WRITING', { attempt: 1, block: 517, blocks: 517 })
    status('VERIFYING', { attempt: 1 })
    expect(seen.steps).toEqual([2, 3])
    // The bar holds its high-water mark until the retry's write passes it.
    expect(seen.pct).toEqual([58, 100])
    expect(seen.notes).toEqual([{ kind: 'retrying', n: 1, of: 2 }, { kind: 'recovered' }])
    expect(watch.furthest).toBe(3)
  })

  it('nothing seen past CONNECTED is nothing erased, unless statuses were missed', () => {
    const { watch, status } = watched()
    status('CONNECTED')
    expect(watch.mayBeErased).toBe(false)
    watch.partial = true
    expect(watch.mayBeErased).toBe(true)
  })
})

describe('uploader run: results', () => {
  const run = new UploaderRun(
    {} as UploaderClient,
    {
      linkUp: () => true,
      events: () => {},
      now: () => 0
    },
    { pollMs: 1000 }
  )
  const board = { name: 'PDU · Left', to: '0.3.0' }
  const result = (r: UplOutcome['result'], fw?: string): UplOutcome =>
    ({ via: 'result', result: r, target: 3, ...(fw && { fw }) }) as UplOutcome

  it('a refusal before the erase left nothing written; after it, the board in its bootloader', () => {
    const before = watched()
    before.status('CONNECTED')
    expect(run.outcome(result('ID_MISMATCH'), before.watch, board)).toMatchObject({
      ok: false,
      failure: { kind: 'refused', why: 'wrong-id' },
      after: 'refused'
    })
    const after = watched()
    after.status('WRITING', { block: 517, blocks: 517 })
    expect(run.outcome(result('ID_MISMATCH'), after.watch, board)).toMatchObject({
      after: 'erased'
    })
  })

  it('WRITE_FAILED is always after the erase began; OK reports its version', () => {
    const { watch } = watched()
    expect(run.outcome(result('WRITE_FAILED'), watch, board)).toMatchObject({
      failure: { kind: 'write-failed' },
      after: 'erased'
    })
    expect(run.outcome(result('OK', '0.3.0'), watch, board)).toEqual({ ok: true, reports: '0.3.0' })
  })
})
