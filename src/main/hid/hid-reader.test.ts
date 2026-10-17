import { describe, expect, it } from 'vitest'
import { HidReader } from './hid'

/** The private surface this test drives; the class deliberately exposes none of it. */
type Innards = {
  opening: boolean
  device?: { close(): void }
  reopen(): void
  stop(): void
}

describe('HidReader.reopen', () => {
  it('leaves an in-flight open alone, and releases a stale handle otherwise', () => {
    // The first serial open fires the same callback a reconnect does, so reopen() can arrive
    // while start()'s open is still awaiting node-hid. Both completing would leave an orphaned
    // handle emitting reports into a reader that no longer references it.
    //
    // This lives outside session.test.ts on purpose: that file mocks './hid', so the same test
    // there exercised the stub rather than any of this.
    const reader = new HidReader() as unknown as Innards
    let closed = 0
    reader.device = { close: () => void closed++ }

    reader.opening = true
    reader.reopen()
    expect(closed, 'the handle survives: the in-flight open is left to land').toBe(0)

    reader.opening = false
    reader.reopen()
    expect(closed, 'and once nothing is in flight, the stale handle is released').toBe(1)
    reader.stop()
  })

  it('does nothing once stopped, so a late callback cannot resurrect it', () => {
    const reader = new HidReader() as unknown as Innards
    let closed = 0
    reader.stop()
    reader.device = { close: () => void closed++ }
    reader.reopen()
    expect(closed).toBe(0)
  })
})
