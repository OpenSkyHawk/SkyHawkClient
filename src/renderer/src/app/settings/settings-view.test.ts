import { describe, expect, it } from 'vitest'
import { hiddenRow, resetButtonLabel, resetRowDesc } from './settings-view'
import { importDoneText, importRowKey, importSubtitle } from '../../config/import-view'

describe('reset texts', () => {
  it('describes the row and labels the confirm button', () => {
    expect(resetRowDesc(0)).toBe('Every node matches NODE_IDS.md')
    expect(resetRowDesc(1)).toMatch(/^1 node differs from NODE_IDS.md/)
    expect(resetRowDesc(3)).toMatch(/^3 nodes differ from NODE_IDS.md/)
    expect(resetButtonLabel(3, 0)).toBe('Reset 3 nodes')
    expect(resetButtonLabel(1, 2)).toBe('Reset 1 node + forget 2')
    expect(resetButtonLabel(0, 1)).toBe('Forget 1 adopted node')
    expect(resetButtonLabel(0, 0)).toBe('Reset') // nothing to do: never "Forget 0 …"
  })
})

describe('import texts', () => {
  it('subtitle, row keys and the done line', () => {
    const at = new Date(2026, 9, 12, 21, 2).toISOString()
    expect(importSubtitle({ fileName: 'a.json', exportedAt: at, client: '0.2.0' })).toBe(
      'a.json · exported 2026-10-12 21:02 · client v0.2.0'
    )
    expect(importSubtitle({ fileName: 'a.json', exportedAt: 'x' })).toBe('a.json')
    const labels = ['Roll', 'Pitch', 'Throttle']
    expect(importRowKey({ k: 'DCS host' }, labels, false)).toBe('DCS host')
    expect(importRowKey({ k: 'Axis 2', axis: 2, board: 'A7' }, labels, false)).toBe('Throttle')
    expect(importRowKey({ k: 'Axis 2', axis: 2, board: 'A7' }, labels, true)).toBe('Throttle · A7')
    expect(importRowKey({ k: 'Axis 9', axis: 9 }, labels, false)).toBe('Axis 9')
    expect(importDoneText(1, false)).toBe('Applied 1 section')
    expect(importDoneText(3, true)).toBe(
      'Applied 3 sections · backup saved, listed under Automatic backups'
    )
  })
})

describe('hiddenRow (#76)', () => {
  const hidden = { kind: 'panel', source: 'registry' } as const

  it('uses the name and console the Cockpit showed: a renamed registry node', () => {
    expect(hiddenRow({ ...hidden, nodeId: 2, name: 'Nav_Repeater', console: 'Left' })).toEqual({
      nodeId: 2,
      label: 'Nav_Repeater',
      desc: 'Left console · returns when it reports again'
    })
  })

  it('an adopted node keeps the name the user gave it', () => {
    expect(
      hiddenRow({ ...hidden, nodeId: 41, name: 'Left_Lights', console: 'Left', source: 'adopted' })
        .label
    ).toBe('Left_Lights')
  })

  it('no console, no console part', () => {
    expect(
      hiddenRow({ ...hidden, nodeId: 41, name: 'Spare', console: '', source: 'adopted' }).desc
    ).toBe('returns when it reports again')
  })
})
