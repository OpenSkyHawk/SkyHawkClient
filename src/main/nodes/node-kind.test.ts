import { describe, expect, it } from 'vitest'
import { resolveKind } from './node-kind'
import { isAdoptableKind, reportedIdentity } from '@shared/nodes/legacy-rules'

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

describe('resolveKind', () => {
  it('the board’s own report beats PDU telemetry and what was stored', () => {
    expect(resolveKind({ reported: 1, pduTelemetry: true, stored: 'pdu' })).toBe('panel')
    expect(resolveKind({ reported: 2, stored: 'panel' })).toBe('pdu')
  })

  it('without a report, PDU telemetry beats what was stored', () => {
    expect(resolveKind({ reported: 0, pduTelemetry: true, stored: 'panel' })).toBe('pdu')
  })

  it('then the stored (registry or adopted) kind; else nothing is known', () => {
    expect(resolveKind({ stored: 'pdu' })).toBe('pdu')
    expect(resolveKind({ reported: 0 })).toBeUndefined()
    expect(resolveKind({})).toBeUndefined()
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
