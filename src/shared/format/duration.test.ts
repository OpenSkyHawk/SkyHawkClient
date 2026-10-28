import { describe, expect, it } from 'vitest'
import { aboutSeconds } from './duration'

describe('aboutSeconds (#173)', () => {
  it('seconds under a minute, whole minutes from 60 s, rounded to the nearest', () => {
    expect(aboutSeconds(5)).toBe('about 5 s')
    expect(aboutSeconds(59)).toBe('about 59 s')
    expect(aboutSeconds(60)).toBe('about 1 min')
    expect(aboutSeconds(89)).toBe('about 1 min')
    expect(aboutSeconds(90)).toBe('about 2 min')
    expect(aboutSeconds(300)).toBe('about 5 min')
  })
})
