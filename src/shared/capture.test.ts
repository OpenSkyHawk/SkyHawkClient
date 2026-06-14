import { describe, expect, it } from 'vitest'
import {
  CAPTURE_FORMAT,
  captureDurationMs,
  parseCapture,
  serializeCapture,
  type CaptureEvent
} from './capture'

const events: CaptureEvent[] = [
  { t: 0, dir: 'in', hex: '5555' },
  { t: 120, dir: 'out', hex: '4142' },
  { t: 340, dir: 'in', hex: 'abcd' }
]

describe('capture serialize/parse', () => {
  it('round-trips events and metadata', () => {
    const text = serializeCapture(events, { aircraft: 'A-4E-C' })
    const file = parseCapture(text)
    expect(file.format).toBe(CAPTURE_FORMAT)
    expect(file.aircraft).toBe('A-4E-C')
    expect(file.events).toEqual(events)
    expect(typeof file.createdAt).toBe('string')
  })

  it('rejects an unknown format', () => {
    expect(() => parseCapture('{"format":"nope","events":[]}')).toThrow(/format/)
  })

  it('rejects a missing events array', () => {
    expect(() => parseCapture(`{"format":"${CAPTURE_FORMAT}"}`)).toThrow(/events/)
  })

  it('reports duration from the last event', () => {
    expect(captureDurationMs(parseCapture(serializeCapture(events)))).toBe(340)
  })
})
