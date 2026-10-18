// T23 — Log › Stream: the DCS-BIOS stream, its filters, Raw, Pause, Clear and Export.
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { Log } from '../src/app/log/Log'
import { renderScenario } from './render'
import { connected, streamRow } from './scenarios'

const T = (s: number) => new Date(2026, 9, 16, 12, 0, s).getTime()

/** Three rows main forwarded, oldest first: two exports from DCS, one command to it. */
const batch = () => [
  streamRow(0x1a0, { t: T(1), name: 'MASTER_ARM', value: 1 }),
  streamRow(0x84c2, { t: T(2), name: 'ARC51_FREQ', value: '251.00' }),
  streamRow(0x1a2, {
    t: T(3),
    dir: 'out',
    name: 'GUN_ARM',
    value: 'TOGGLE',
    raw: 'GUN_ARM TOGGLE'
  })
]

/** The listed rows, top to bottom: time, direction, control, value. */
const rows = () =>
  screen.queryAllByText(/^(IN ▸|◂ OUT)$/).map((dir) => dir.parentElement!.textContent)

async function openStream() {
  const r = await renderScenario(<Log />, { device: connected(), stream: batch() })
  expect(screen.getByRole('tab', { name: 'Stream 3' })).toHaveAttribute('aria-selected', 'true')
  const button = (name: string) => screen.getByRole('button', { name })
  return { ...r, button }
}

describe('T23 Log › Stream (B77)', () => {
  it('lists the stream newest first; the direction filter picks In or Out', async () => {
    const { user, button } = await openStream()
    expect(rows()).toEqual([
      '12:00:03.000◂ OUTGUN_ARMTOGGLE',
      '12:00:02.000IN ▸ARC51_FREQ251.00',
      '12:00:01.000IN ▸MASTER_ARM1'
    ])
    expect(screen.getByText('3 rows · 0 frames/s')).toBeInTheDocument()
    await user.click(button('In'))
    expect(rows()).toEqual(['12:00:02.000IN ▸ARC51_FREQ251.00', '12:00:01.000IN ▸MASTER_ARM1'])
    await user.click(button('Out'))
    expect(rows()).toEqual(['12:00:03.000◂ OUTGUN_ARMTOGGLE'])
    await user.click(button('All'))
    expect(rows()).toHaveLength(3)
  })

  it('search matches the control name or the address, case-insensitive', async () => {
    const { user } = await openStream()
    const search = screen.getByPlaceholderText('Search name or address…')
    await user.type(search, 'arm')
    expect(rows()).toEqual(['12:00:03.000◂ OUTGUN_ARMTOGGLE', '12:00:01.000IN ▸MASTER_ARM1'])
    await user.clear(search)
    await user.type(search, '0x84c2')
    expect(rows()).toEqual(['12:00:02.000IN ▸ARC51_FREQ251.00'])
    expect(screen.getByText('1 rows · 0 frames/s')).toBeInTheDocument()
  })

  it('Raw shows the address and the raw bytes, under "Address"', async () => {
    const { user, button } = await openStream()
    expect(screen.getByText('Control')).toBeInTheDocument()
    await user.click(button('Decoded'))
    expect(screen.getByText('Address')).toBeInTheDocument()
    expect(screen.queryByText('Control')).toBeNull()
    expect(rows()).toEqual([
      '12:00:03.000◂ OUT0x01A2GUN_ARM TOGGLE',
      '12:00:02.000IN ▸0x84C284 C2 00 00',
      '12:00:01.000IN ▸0x01A001 A0 01 00'
    ])
  })

  // #161: rows that arrived while paused used to be dropped, never shown.
  it('Pause freezes the list and holds what arrives; Resume shows it', async () => {
    const { user, sky, button } = await openStream()
    await user.click(button('❚❚ Pause'))
    expect(screen.getByText('PAUSED')).toBeInTheDocument()
    sky.emitScenario({ stream: [streamRow(0x1a4, { t: T(4), name: 'FLAPS', value: 2 })] })
    sky.emitScenario({ stream: [streamRow(0x1a6, { t: T(5), name: 'HOOK', value: 1 })] })
    expect(rows(), 'the list holds still while paused').toHaveLength(3)

    await user.click(button('▶ Resume'))
    expect(screen.getByText('LIVE')).toBeInTheDocument()
    expect(rows()).toEqual([
      '12:00:05.000IN ▸HOOK1',
      '12:00:04.000IN ▸FLAPS2',
      '12:00:03.000◂ OUTGUN_ARMTOGGLE',
      '12:00:02.000IN ▸ARC51_FREQ251.00',
      '12:00:01.000IN ▸MASTER_ARM1'
    ])
    sky.emitScenario({ stream: [streamRow(0x1a8, { t: T(6), name: 'GEAR', value: 0 })] })
    expect(rows()[0]).toBe('12:00:06.000IN ▸GEAR0')
  })

  it('rows held while paused keep the list’s cap: the oldest fall off as they do live', async () => {
    const { user, sky, button } = await openStream()
    await user.click(button('❚❚ Pause'))
    const many = Array.from({ length: 1000 }, (_, i) =>
      streamRow(0x1a4, { t: T(4) + i, name: `HELD_${i}`, value: i })
    )
    sky.emitScenario({ stream: many })
    expect(rows()).toHaveLength(3)
    await user.click(button('▶ Resume'))
    expect(screen.getByRole('tab', { name: 'Stream 1,000' })).toBeInTheDocument()
    expect(rows()[0]).toMatch(/HELD_999/)
    expect(screen.queryByText('MASTER_ARM'), 'the oldest rows fell off').toBeNull()
  })

  it('Clear while paused also drops what was held', async () => {
    const { user, sky, button } = await openStream()
    await user.click(button('❚❚ Pause'))
    sky.emitScenario({ stream: [streamRow(0x1a4, { t: T(4), name: 'FLAPS', value: 2 })] })
    await user.click(button('Clear'))
    sky.emitScenario({ stream: [streamRow(0x1a6, { t: T(5), name: 'HOOK', value: 1 })] })
    expect(rows()).toEqual([])
    await user.click(button('▶ Resume'))
    expect(rows(), 'only what arrived after Clear').toEqual(['12:00:05.000IN ▸HOOK1'])
  })

  it('Clear empties the view on this side only', async () => {
    const { user, sky, button } = await openStream()
    await user.click(button('Clear'))
    expect(rows()).toEqual([])
    expect(screen.getByRole('tab', { name: 'Stream 0' })).toBeInTheDocument()
    expect(sky.clearEvents).not.toHaveBeenCalled()
  })

  it('Export hands main the stream as TSV, oldest first, and the footer says where', async () => {
    const { user, sky, button } = await openStream()
    sky.exportLog.mockResolvedValueOnce({ path: '/Users/me/Documents/skyhawk-stream.tsv' })
    await user.click(button('Export'))
    expect(sky.exportLog).toHaveBeenCalledWith(
      'time\tdir\tcontrol\taddress\tvalue\traw\n' +
        '12:00:01.000\tin\tMASTER_ARM\t0x01A0\t1\t01 A0 01 00\n' +
        '12:00:02.000\tin\tARC51_FREQ\t0x84C2\t251.00\t84 C2 00 00\n' +
        '12:00:03.000\tout\tGUN_ARM\t0x01A2\tTOGGLE\tGUN_ARM TOGGLE\n'
    )
    expect(await screen.findByText('✓ Saved skyhawk-stream.tsv · 3 rows')).toBeInTheDocument()
  })

  it('Export with an empty stream asks main for nothing', async () => {
    const { user, sky, button } = await openStream()
    await user.click(button('Clear'))
    await user.click(button('Export'))
    expect(sky.exportLog).not.toHaveBeenCalled()
  })
})
