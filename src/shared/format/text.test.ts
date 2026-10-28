import { describe, expect, it } from 'vitest'
import { DASH, errorText, fileName, onOff, plural, title, unknownLabel } from './text'

describe('plural', () => {
  it('one for 1, the plural otherwise', () => {
    expect(plural(1, 'node')).toBe('1 node')
    expect(plural(3, 'node')).toBe('3 nodes')
    expect(plural(0, 'change')).toBe('0 changes')
    expect(plural(1, 'adopted node')).toBe('1 adopted node')
    expect(plural(3, 'new device')).toBe('3 new devices')
    expect(plural(2, 'PDU')).toBe('2 PDUs')
  })

  it('takes an irregular plural', () => {
    expect(plural(1, 'child', 'children')).toBe('1 child')
    expect(plural(2, 'child', 'children')).toBe('2 children')
  })
})

describe('onOff', () => {
  it('reads a boolean setting as On / Off', () => {
    expect(onOff(true)).toBe('On')
    expect(onOff(false)).toBe('Off')
  })
})

describe('title', () => {
  it('upper-cases the first letter only', () => {
    expect(title('bus-off')).toBe('Bus-off')
    expect(title('error-passive')).toBe('Error-passive')
    expect(title('Overheat')).toBe('Overheat')
  })
})

describe('unknownLabel', () => {
  it('sentence (the default), word and badge forms', () => {
    expect(unknownLabel('fault', 0xee)).toBe('Unknown fault (0xEE)')
    expect(unknownLabel('fault', 0xee, 'sentence')).toBe('Unknown fault (0xEE)')
    expect(unknownLabel('fault', 0xee, 'word')).toBe('unknown fault (0xEE)')
    expect(unknownLabel('fault', 0xee, 'badge')).toBe('UNKNOWN FAULT (0xEE)')
  })

  it('a multi-word what', () => {
    expect(unknownLabel('board type', 7)).toBe('Unknown board type (0x07)')
  })

  it('badge upper-cases the words, never the 0x', () => {
    expect(unknownLabel('reason', 0x0f, 'badge')).toBe('UNKNOWN REASON (0x0F)')
    expect(unknownLabel('fault', 0xee, 'badge')).not.toContain('0X')
  })

  it('(?) when there is no code', () => {
    expect(unknownLabel('board type', undefined)).toBe('Unknown board type (?)')
    expect(unknownLabel('fault', undefined, 'word')).toBe('unknown fault (?)')
  })
})

describe('DASH', () => {
  it('is an em dash', () => {
    expect(DASH).toBe('—')
  })
})

describe('fileName', () => {
  it('keeps the last part of a POSIX or Windows path', () => {
    expect(fileName('/Users/x/skyhawk-events-1.tsv')).toBe('skyhawk-events-1.tsv')
    expect(fileName('C:\\x\\skyhawk-log-2.tsv')).toBe('skyhawk-log-2.tsv')
    expect(fileName('plain.json')).toBe('plain.json')
  })
})

describe('errorText', () => {
  it("an Error's message; anything else as a string", () => {
    expect(errorText(new Error('EACCES: permission denied'))).toBe('EACCES: permission denied')
    expect(errorText(new TypeError('bad'))).toBe('bad')
    expect(errorText('disk full')).toBe('disk full')
    expect(errorText(42)).toBe('42')
    expect(errorText(undefined)).toBe('undefined')
  })
})
