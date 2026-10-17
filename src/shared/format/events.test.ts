import { describe, expect, it } from 'vitest'
import { eventText } from './events'

describe('eventText', () => {
  it('`event · detail`, or the event alone', () => {
    expect(eventText({ event: '5V UNDER-V raised', detail: '4.71 V' })).toBe(
      '5V UNDER-V raised · 4.71 V'
    )
    expect(eventText({ event: 'link error', detail: 'connect ECONNREFUSED' })).toBe(
      'link error · connect ECONNREFUSED'
    )
    expect(eventText({ event: 'offline' })).toBe('offline')
    expect(eventText({ event: 'offline', detail: '' })).toBe('offline')
  })
})
