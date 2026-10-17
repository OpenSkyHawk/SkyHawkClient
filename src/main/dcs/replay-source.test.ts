import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReplaySource } from './replay'
import type { CaptureFile } from '@shared/capture'

const file: CaptureFile = {
  format: 'skyhawk-capture/1',
  createdAt: '2026-01-01T00:00:00.000Z',
  aircraft: 'A-4E-C',
  events: [
    { t: 0, dir: 'in', hex: '5555' },
    { t: 100, dir: 'out', hex: '4142' }, // commands are not replayed as export
    { t: 200, dir: 'in', hex: 'abcd' }
  ]
}

afterEach(() => vi.useRealTimers())

describe('ReplaySource', () => {
  it('reports info from the capture', () => {
    const info = new ReplaySource(file).info()
    expect(info).toEqual({ events: 3, durationMs: 200, aircraft: 'A-4E-C' })
  })

  it('emits only "in" events at their recorded timing, then onDone', () => {
    vi.useFakeTimers()
    const chunks: string[] = []
    const done = vi.fn()
    new ReplaySource(file).play((c) => chunks.push(c.toString('hex')), done)

    vi.advanceTimersByTime(0)
    expect(chunks).toEqual(['5555'])
    vi.advanceTimersByTime(200)
    expect(chunks).toEqual(['5555', 'abcd'])
    expect(done).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(done).toHaveBeenCalledOnce()
  })
})
