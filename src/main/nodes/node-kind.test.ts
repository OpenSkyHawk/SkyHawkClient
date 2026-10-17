import { describe, expect, it } from 'vitest'
import type { MappedNode } from '@shared/nodes'
import {
  boardIdentity,
  identityOf,
  isAdoptableKind,
  reportedIdentity,
  requireAdoptable
} from './node-kind'
import { MappingError } from './mapping-error'

describe('reportedIdentity', () => {
  it('maps the v3 nodeKind byte; 0 (or no row) is not a report', () => {
    expect(reportedIdentity(undefined)).toBeUndefined()
    expect(reportedIdentity(0)).toBeUndefined()
    expect(reportedIdentity(1)).toBe('panel')
    expect(reportedIdentity(2)).toBe('pdu')
    expect(reportedIdentity(3)).toBe('bridge')
    expect(reportedIdentity(9)).toBe('other') // a kind a newer firmware adds
  })
})

describe('identityOf', () => {
  it('the board’s own report beats PDU telemetry and what was stored', () => {
    expect(identityOf({ reported: 1, pduTelemetry: true, stored: 'pdu' })).toBe('panel')
    expect(identityOf({ reported: 2, stored: 'panel' })).toBe('pdu')
  })

  it('without a report, PDU telemetry beats what was stored', () => {
    expect(identityOf({ reported: 0, pduTelemetry: true, stored: 'panel' })).toBe('pdu')
  })

  it('then the stored (registry or adopted) kind; else nothing is known', () => {
    expect(identityOf({ stored: 'pdu' })).toBe('pdu')
    expect(identityOf({ reported: 0 })).toBeUndefined()
    expect(identityOf({})).toBeUndefined()
  })
})

describe('isAdoptableKind', () => {
  it('is a whitelist: a PDU or a panel group only', () => {
    expect(isAdoptableKind('pdu')).toBe(true)
    expect(isAdoptableKind('panel')).toBe(true)
    expect(isAdoptableKind('bridge')).toBe(false)
    expect(isAdoptableKind('other')).toBe(false)
    expect(isAdoptableKind(undefined)).toBe(false)
  })
})

describe('requireAdoptable (S7: the one adopt gate)', () => {
  it('lets a PDU or a panel group through, as what it said', () => {
    expect(requireAdoptable('pdu')).toBe('pdu')
    expect(requireAdoptable('panel', 'panel')).toBe('panel')
  })

  it('refuses a board that has not said, one that can’t be adopted, and a kind it didn’t say', () => {
    expect(() => requireAdoptable(undefined)).toThrow(
      new MappingError('Its board type is not known yet')
    )
    for (const k of ['bridge', 'other'] as const) {
      expect(() => requireAdoptable(k)).toThrow(new MappingError('This board cannot be adopted'))
    }
    expect(() => requireAdoptable('pdu', 'panel')).toThrow(new MappingError('It reports as a PDU'))
    expect(() => requireAdoptable('panel', 'pdu')).toThrow(
      new MappingError('It reports as a panel group')
    )
  })
})

describe('boardIdentity', () => {
  const m = (nodeId: number, kind: 'pdu' | 'panel', known: boolean): MappedNode => ({
    nodeId,
    name: `n${nodeId}`,
    console: 'Left',
    pduId: null,
    kind,
    source: 'registry',
    differs: false,
    hidden: false,
    known
  })
  const mapped = new Map([
    [3, m(3, 'pdu', true)],
    [4, m(4, 'pdu', false)]
  ])

  it('a board in your cockpit has its stored kind; one outside it only what it reports', () => {
    expect(boardIdentity(mapped, 3, {})).toBe('pdu')
    expect(boardIdentity(mapped, 4, {})).toBeUndefined() // a registry PDU not added: not a guess
    expect(boardIdentity(mapped, 4, { reported: 1 })).toBe('panel')
    expect(boardIdentity(mapped, 3, { reported: 1 })).toBe('panel') // what it says wins
    expect(boardIdentity(mapped, 9, { pduTelemetry: true })).toBe('pdu')
  })
})
