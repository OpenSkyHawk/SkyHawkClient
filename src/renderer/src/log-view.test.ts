import { describe, expect, it } from 'vitest'
import type { LogEvent } from '@shared/events/ipc'
import { fileName } from '@shared/format'
import {
  boardEventLine,
  eventSourceLabel,
  filterEvents,
  mergeEvents,
  restoreEvents,
  rowsThatFit
} from './log-view'

describe('Board events (Cockpit)', () => {
  it('a node row is its name and event; the roster summary stands alone', () => {
    expect(
      boardEventLine({ nodeId: 4, name: 'PDU_Right', event: '5V UNDER-V raised', detail: '4.71 V' })
    ).toBe('PDU_Right 5V UNDER-V raised · 4.71 V')
    expect(boardEventLine({ nodeId: 27, name: 'Center_Clock', event: 'bus-off' })).toBe(
      'Center_Clock bus-off'
    )
    expect(boardEventLine({ name: 'roster', event: '40 nodes online' })).toBe('40 nodes online')
  })

  it('shows whole rows only, at least one, at most max; unmeasured shows max', () => {
    expect(rowsThatFit(200, 33, 30)).toBe(6) // 6.06 → 6, never a half row
    expect(rowsThatFit(198, 33, 30)).toBe(6)
    expect(rowsThatFit(197, 33, 30)).toBe(5)
    expect(rowsThatFit(10, 33, 30)).toBe(1)
    expect(rowsThatFit(5000, 33, 30)).toBe(30)
    expect(rowsThatFit(200, 0, 30)).toBe(30)
  })
})

const ev = (id: number, over: Partial<LogEvent> = {}): LogEvent => ({
  id,
  t: id,
  source: 'node',
  name: 'PDU_Right',
  severity: 'info',
  event: 'online',
  raw: '',
  ...over
})

const ROWS = [
  ev(5, {
    source: 'client',
    name: 'SERIAL',
    severity: 'error',
    event: 'serial port error',
    detail: 'write EIO'
  }),
  ev(4, { severity: 'warn', event: '5V UNDER-V raised', detail: '4.71 V' }),
  ev(3, { name: 'Node 41', severity: 'new', event: 'new on the bus' }),
  ev(2, { name: 'Center_Clock', severity: 'error', event: 'bus-off' }),
  ev(1, { source: 'client', name: 'Relay', event: 'started' })
]
const all = { source: 'all' as const, problemsOnly: false, search: '' }
const ids = (es: LogEvent[]) => es.map((e) => e.id)

describe('filterEvents', () => {
  it('filters by source', () => {
    expect(ids(filterEvents(ROWS, { ...all, source: 'node' }))).toEqual([4, 3, 2])
    expect(ids(filterEvents(ROWS, { ...all, source: 'client' }))).toEqual([5, 1])
  })

  it('problems only keeps ✕ and ! rows', () => {
    expect(ids(filterEvents(ROWS, { ...all, problemsOnly: true }))).toEqual([5, 4, 2])
  })

  it('searches the source label and the event text, case-insensitively', () => {
    expect(ids(filterEvents(ROWS, { ...all, search: 'client · ser' }))).toEqual([5])
    expect(ids(filterEvents(ROWS, { ...all, search: '4.71' }))).toEqual([4])
    expect(ids(filterEvents(ROWS, { ...all, search: '  CLOCK ' }))).toEqual([2])
  })

  it('holds back rows newer than the pause mark', () => {
    expect(ids(filterEvents(ROWS, { ...all, pauseMark: 3 }))).toEqual([3, 2, 1])
  })
})

describe('mergeEvents / restoreEvents', () => {
  it('prepends a push newest first and skips ids already held', () => {
    const cur = [ev(2), ev(1)]
    expect(ids(mergeEvents(cur, [ev(2), ev(3), ev(4)]))).toEqual([4, 3, 2, 1])
    expect(mergeEvents(cur, [ev(1)])).toBe(cur)
  })

  it('caps the list, dropping the oldest', () => {
    expect(ids(mergeEvents([ev(2), ev(1)], [ev(3)], 2))).toEqual([3, 2])
  })

  it('a reload: union of the snapshot and pushes that beat it', () => {
    expect(ids(restoreEvents([ev(4)], [ev(1), ev(2), ev(3), ev(4)]))).toEqual([4, 3, 2, 1])
  })
})

describe('labels', () => {
  it('client rows read "Client · …"; node rows are the node name', () => {
    expect(eventSourceLabel({ source: 'client', name: 'DCS' })).toBe('Client · DCS')
    expect(eventSourceLabel({ source: 'node', name: 'Left_Trim' })).toBe('Left_Trim')
  })

  it('fileName takes the last path segment', () => {
    expect(fileName('/Users/x/skyhawk-events-1.tsv')).toBe('skyhawk-events-1.tsv')
    expect(fileName('C:\\x\\skyhawk-log-2.tsv')).toBe('skyhawk-log-2.tsv')
  })
})
