import { describe, expect, it } from 'vitest'
import {
  day,
  fmtDateTime,
  fmtTime,
  fmtUptime,
  hhmm,
  hhmmss,
  lastSeenLabel,
  pad,
  pad3,
  seenAgo,
  stamp,
  ago,
  dayMonth
} from './time'

/** 16 Oct 2026, 21:14:07.412 local time. */
const T = new Date(2026, 9, 16, 21, 14, 7, 412).getTime()
/** 2 Mar 2026, 09:05:03.007 local time: every field needs its padding. */
const EARLY = new Date(2026, 2, 2, 9, 5, 3, 7).getTime()

describe('pad / pad3', () => {
  it('pads to two and three digits', () => {
    expect(pad(7)).toBe('07')
    expect(pad(42)).toBe('42')
    expect(pad(123)).toBe('123')
    expect(pad3(7)).toBe('007')
    expect(pad3(412)).toBe('412')
  })
})

describe('clock times', () => {
  it('fmtTime: HH:MM:SS.mmm', () => {
    expect(fmtTime(T)).toBe('21:14:07.412')
    expect(fmtTime(EARLY)).toBe('09:05:03.007')
  })

  it('hhmmss: fmtTime without the milliseconds', () => {
    expect(hhmmss(T)).toBe('21:14:07')
    expect(hhmmss(EARLY)).toBe('09:05:03')
  })

  it('hhmm: HH:MM', () => {
    expect(hhmm(T)).toBe('21:14')
    expect(hhmm(EARLY)).toBe('09:05')
  })
})

describe('dates', () => {
  it('day: YYYY-MM-DD', () => {
    expect(day(T)).toBe('2026-10-16')
    expect(day(EARLY)).toBe('2026-03-02')
  })

  it('fmtDateTime: day and fmtTime', () => {
    expect(fmtDateTime(T)).toBe('2026-10-16 21:14:07.412')
    expect(fmtDateTime(EARLY)).toBe('2026-03-02 09:05:03.007')
  })

  it('lastSeenLabel: "16 Oct, 21:14"', () => {
    expect(lastSeenLabel(T)).toBe('16 Oct, 21:14')
    expect(lastSeenLabel(EARLY)).toBe('2 Mar, 09:05')
  })

  it('stamp: the UTC ISO time, safe for a file name', () => {
    expect(stamp(new Date(Date.UTC(2026, 9, 16, 10, 0, 0)))).toBe('2026-10-16T10-00-00-000Z')
    expect(stamp(new Date(Date.UTC(2026, 9, 16, 21, 14, 7, 412)))).toBe('2026-10-16T21-14-07-412Z')
  })
})

describe('ago / dayMonth', () => {
  it('just now, minutes, hours, then days', () => {
    expect(ago(0, 59_000)).toBe('just now')
    expect(ago(0, 2 * 60_000 + 5_000)).toBe('2 min ago')
    expect(ago(0, 3 * 3_600_000)).toBe('3 h ago')
    expect(ago(0, 50 * 3_600_000)).toBe('2 d ago')
    expect(ago(10_000, 0)).toBe('just now')
  })

  it('a release date as "29 Nov"', () => {
    expect(dayMonth(new Date(2026, 10, 29, 20, 35).getTime())).toBe('29 Nov')
  })
})

describe('seenAgo', () => {
  it('just now, minutes, then hours', () => {
    expect(seenAgo(0, 30_000)).toBe('first seen just now')
    expect(seenAgo(0, 2 * 60_000 + 5_000)).toBe('first seen 2 min ago')
    expect(seenAgo(0, 3 * 3_600_000)).toBe('first seen 3 h ago')
    expect(seenAgo(undefined, 0)).toBe('first seen this session')
  })
})

describe('fmtUptime', () => {
  it('seconds as HH:MM:SS', () => {
    expect(fmtUptime(130)).toBe('00:02:10')
    expect(fmtUptime(3725)).toBe('01:02:05')
    expect(fmtUptime(59)).toBe('00:00:59')
    expect(fmtUptime(360_000)).toBe('100:00:00')
  })
})
