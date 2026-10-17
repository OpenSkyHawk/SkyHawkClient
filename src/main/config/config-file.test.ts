import { describe, expect, it } from 'vitest'
import { applyToConfig, buildConfigFile, diffImport, parseConfigFile } from './config-file'
import { mergeCalibration } from '../hid/calibration/cache-rules'
import { CONFIG_FORMAT, DEFAULT_CONFIG, type ConfigSnapshot, type SectionId } from '@shared/config'
import { registryDefaults } from '../nodes/registry'
import { DEFAULT_PSU, type NodeMappingFile } from '@shared/nodes'
import type { CalCache } from '@shared/hid/calibration'
import { DEFAULT_APP_SETTINGS } from '../../test-fixtures/config'

const defaults = registryDefaults({
  0: { name: 'PanelBridge', console: '—' },
  1: { name: 'Center_Armament', console: 'Center' },
  2: { name: 'Right_Navigation', console: 'Right' },
  3: { name: 'PDU_Left', console: 'Left' },
  4: { name: 'PDU_Right', console: 'Right' },
  5: { name: 'PDU_Center', console: 'Center' }
})

const axis = (min: number, centre: number, max: number) => ({
  min,
  centre,
  max,
  selfCentring: true
})
const cal = (boards: CalCache['boards']): CalCache => ({ version: 1, boards })

const current: ConfigSnapshot = {
  app: DEFAULT_APP_SETTINGS,
  nodeMapping: { version: 3, nodes: {} },
  powerSupply: DEFAULT_PSU,
  calibration: cal({
    A7: { confirmedAt: '2026-10-01T00:00:00Z', axes: { 2: axis(120, 2000, 3980) } }
  })
}

const roundTrip = (s: Partial<ConfigSnapshot>, extra: Record<string, unknown> = {}) =>
  parseConfigFile(
    JSON.stringify({
      ...buildConfigFile(s as ConfigSnapshot, '2026-10-12T21:02:00Z', '0.2.0'),
      ...extra
    })
  )

describe('parseConfigFile', () => {
  it('reads back what was exported', () => {
    const r = roundTrip(current)
    expect(r).toEqual({
      ok: true,
      config: {
        version: 1,
        exportedAt: '2026-10-12T21:02:00Z',
        client: '0.2.0',
        sections: current,
        skipped: [],
        rejected: []
      }
    })
  })

  it('refuses anything that is not an export, whole', () => {
    expect(parseConfigFile('{ nope')).toMatchObject({ ok: false, error: /not valid JSON/ })
    expect(parseConfigFile('[]')).toMatchObject({ ok: false })
    expect(
      parseConfigFile(JSON.stringify({ format: 'other', version: 1, sections: {} }))
    ).toMatchObject({
      ok: false,
      error: 'This is not an OpenSkyhawk Client configuration file.'
    })
    expect(parseConfigFile(JSON.stringify({ format: CONFIG_FORMAT, sections: {} }))).toMatchObject({
      ok: false,
      error: /version/
    })
    expect(
      parseConfigFile(JSON.stringify({ format: CONFIG_FORMAT, version: 1, sections: {} }))
    ).toEqual({
      ok: false,
      error: 'This file has no settings this client can read.'
    })
  })

  it('a newer file: known sections are read, unknown ones listed as skipped', () => {
    const r = parseConfigFile(
      JSON.stringify({
        format: CONFIG_FORMAT,
        version: 3,
        sections: {
          powerSupply: { mode: 'custom', preset: 'nx650', custom: { a12: 40 } },
          macros: { x: 1 },
          app: 'bad'
        }
      })
    )
    expect(r).toEqual({
      ok: true,
      config: {
        version: 3,
        sections: { powerSupply: { mode: 'custom', preset: 'nx650', custom: { a12: 40 } } },
        skipped: ['macros'],
        rejected: [{ id: 'app', reason: 'it is not a settings section' }] // C1: known, but broken
      }
    })
  })
})

describe('parseConfigFile: strict import validation (C1)', () => {
  /** Parse a file with `sections`; what each known section came to: its value or its reason. */
  const read = (sections: Record<string, unknown>) => {
    const r = parseConfigFile(JSON.stringify({ format: CONFIG_FORMAT, version: 1, sections }))
    return r.ok ? { ...r.config.sections, rejected: r.config.rejected } : r
  }
  /** One section's verdict next to a readable powerSupply section (so the file is not refused). */
  const verdict = (id: SectionId, value: unknown) => {
    const r = read({
      [id]: value,
      ...(id === 'powerSupply' ? { app: DEFAULT_APP_SETTINGS } : { powerSupply: DEFAULT_PSU })
    })
    if ('ok' in r) throw new Error(r.error)
    const rej = r.rejected.find((x) => x.id === id)
    return rej ? rej.reason : r[id]
  }

  it('a known section that is not an object is rejected, never read as defaults', () => {
    for (const id of ['app', 'nodeMapping', 'powerSupply', 'calibration'] as SectionId[]) {
      for (const v of ['bad', null, [1, 2], 3]) {
        expect(verdict(id, v)).toBe('it is not a settings section')
      }
    }
  })

  it('app: every setting must be present and valid; `{}` is not "reset to defaults"', () => {
    expect(verdict('app', {})).toBe('it has no “Source mode” setting')
    const { debugMode: _d, ...noDebug } = DEFAULT_APP_SETTINGS
    expect(verdict('app', noDebug)).toBe('it has no “Debug logging” setting')
    expect(verdict('app', { ...DEFAULT_APP_SETTINGS, sourceMode: 'nonsense' })).toBe(
      'its “Source mode” setting is not valid'
    )
    expect(verdict('app', { ...DEFAULT_APP_SETTINGS, host: '' })).toBe(
      'its “DCS host” setting is not valid'
    )
    expect(verdict('app', { ...DEFAULT_APP_SETTINGS, commandPort: 'x' })).toBe(
      'its “Command port” setting is not valid'
    )
    // Complete: read as written. A key a newer client added, and a stray psu, are ignored.
    const app = { ...DEFAULT_APP_SETTINGS, host: '10.0.0.2', debugMode: true }
    expect(verdict('app', { ...app, futureSetting: 1, psu: { mode: 'custom' } })).toEqual(app)
  })

  it('nodeMapping: its markers are `version` and `nodes`; `{}` is not an empty cockpit', () => {
    expect(verdict('nodeMapping', {})).toBe('it has no version')
    expect(verdict('nodeMapping', { nodes: {} })).toBe('it has no version')
    expect(verdict('nodeMapping', { version: 'x', nodes: {} })).toBe('it has no version')
    expect(verdict('nodeMapping', { version: 3 })).toBe('it has no list of boards')
    expect(verdict('nodeMapping', { version: 3, nodes: [] })).toBe('it has no list of boards')
    expect(verdict('nodeMapping', { version: 4, nodes: {} })).toBe(
      'it was written by a newer client'
    )
    // With both, an empty list is a real empty cockpit, and entries are read tolerantly.
    expect(verdict('nodeMapping', { version: 3, nodes: {} })).toEqual({ version: 3, nodes: {} })
    expect(
      verdict('nodeMapping', {
        version: 3,
        nodes: { 99: { name: 'out of range' }, 2: { name: 'Nav', pduId: 'x' } }
      })
    ).toEqual({ version: 3, nodes: { 2: { name: 'Nav' } } })
    // An older client's file (v1, with its ignore list) is upgraded as a local one is.
    expect(
      verdict('nodeMapping', { version: 1, nodes: { 2: { name: 'Nav' } }, ignored: [3] })
    ).toEqual({ version: 3, nodes: { 2: { name: 'Nav', added: true } } })
  })

  it('powerSupply: `mode`, `preset` and `custom` must be there, and every limit valid', () => {
    expect(verdict('powerSupply', {})).toBe(
      'it does not say whether the supply is a preset or custom'
    )
    expect(verdict('powerSupply', { mode: 'custom', custom: {} })).toBe(
      'its preset is not one this client knows'
    )
    expect(verdict('powerSupply', { mode: 'preset', preset: 'nx750', custom: {} })).toBe(
      'its preset is not one this client knows'
    )
    expect(verdict('powerSupply', { mode: 'custom', preset: 'nx650' })).toBe(
      'it has no custom limits'
    )
    expect(verdict('powerSupply', { mode: 'custom', preset: 'nx650', custom: { a5: 'x' } })).toBe(
      'its custom 5 V rail limit is not valid'
    )
    expect(verdict('powerSupply', { mode: 'custom', preset: 'nx650', custom: { w: -1 } })).toBe(
      'its custom total power is not valid'
    )
    expect(
      verdict('powerSupply', { mode: 'custom', preset: 'nx650', custom: { a12: 40 } })
    ).toEqual({ mode: 'custom', preset: 'nx650', custom: { a12: 40 } })
  })

  it('calibration: `version` and `boards`, and per board `confirmedAt` and `axes`', () => {
    expect(verdict('calibration', {})).toBe('it has no version')
    expect(verdict('calibration', { version: 2, boards: {} })).toBe(
      'it was written by a newer client'
    )
    expect(verdict('calibration', { version: 1 })).toBe('it has no list of boards')
    expect(verdict('calibration', { version: 1, boards: { A7: { confirmedAt: 'x' } } })).toBe(
      'its entry for board A7 is incomplete'
    )
    expect(verdict('calibration', { version: 1, boards: { A7: { axes: {} } } })).toBe(
      'its entry for board A7 is incomplete'
    )
    expect(verdict('calibration', { version: 1, boards: { A7: 3 } })).toBe(
      'its entry for board A7 is incomplete'
    )
    // Complete: an axis the device would refuse is dropped, never imported, as from a local file.
    expect(
      verdict('calibration', {
        version: 1,
        boards: { A7: { confirmedAt: 'x', axes: { 0: axis(1, 2, 3), 1: axis(5, 4, 3) } } }
      })
    ).toEqual(cal({ A7: { confirmedAt: 'x', axes: { 0: axis(1, 2, 3) } } }))
    expect(verdict('calibration', { version: 1, boards: {} })).toEqual(cal({}))
  })

  it('a file whose only known sections are rejected is refused, and says why', () => {
    expect(read({ nodeMapping: {}, app: {} })).toEqual({
      ok: false,
      error:
        'This file has no settings this client can read. Node mapping: it has no version. ' +
        'App settings: it has no “Source mode” setting.'
    })
  })
})

describe('diffImport', () => {
  it('the review matches the apply: no "hidden" row for a board on the bus (#93 re-review K)', () => {
    const cur: ConfigSnapshot = {
      ...current,
      nodeMapping: { version: 3, nodes: { 2: { added: true } } }
    }
    const next = {
      nodeMapping: { version: 3 as const, nodes: { 2: { added: true, hidden: true } } }
    }
    expect(diffImport(defaults, cur, next, [2])[0]!.rows).toEqual([])
    expect(diffImport(defaults, cur, next, [])[0]!.rows).toEqual([
      { k: 'Right_Navigation · hidden', from: 'no', to: 'yes' }
    ])
  })

  it('membership as written: the boards that join and leave your cockpit are listed (D3, S4)', () => {
    const seen = '2026-10-14T21:14:00.000Z'
    const cur: ConfigSnapshot = {
      ...current,
      nodeMapping: {
        version: 3,
        nodes: {
          1: { added: true, lastSeen: seen },
          2: { added: true, lastSeen: seen },
          41: { name: 'Trim', console: 'Left', pduId: null, kind: 'panel', lastSeen: seen }
        }
      }
    }
    // The file has 2 (with another computer's last seen) and 4, not 1 or 41.
    const file: NodeMappingFile = {
      version: 3,
      nodes: { 2: { added: true, lastSeen: '2020-01-01T00:00:00.000Z' }, 4: { added: true } }
    }
    expect(diffImport(defaults, cur, { nodeMapping: file })).toEqual([
      {
        id: 'nodeMapping',
        title: 'Node mapping',
        summary: '3 nodes · 1 joins · 2 leave',
        rows: [
          {
            k: 'Center_Armament',
            from: 'Center_Armament · Center · PDU_Center',
            to: 'not in your cockpit'
          },
          { k: 'PDU_Right', from: 'not in your cockpit', to: 'PDU_Right · Right · —' },
          { k: '#41', from: 'Trim · Left · —', to: 'not in your cockpit' }
        ]
      }
    ])
    // Last seen is this computer's, never a row; the same membership reviews as no change.
    const same: NodeMappingFile = {
      version: 3,
      nodes: {
        1: { added: true },
        2: { added: true, lastSeen: '2020-01-01T00:00:00.000Z' },
        41: { name: 'Trim', console: 'Left', pduId: null, kind: 'panel' }
      }
    }
    expect(diffImport(defaults, cur, { nodeMapping: same })[0]).toEqual({
      id: 'nodeMapping',
      title: 'Node mapping',
      summary: '0 nodes',
      rows: []
    })
  })

  it('a hidden flag on a board outside your cockpit is not imported, so not reviewed (S4)', () => {
    const file: NodeMappingFile = {
      version: 3,
      nodes: { 2: { hidden: true }, 52: { hidden: true } }
    }
    expect(diffImport(defaults, current, { nodeMapping: file })[0]!.rows).toEqual([])
  })

  it('lists each change as key  from → to, per section', () => {
    const mapping: NodeMappingFile = {
      version: 3,
      nodes: {
        1: { pduId: 3 },
        2: { name: 'Right_TACAN' },
        41: { name: 'Right_Oxygen', console: 'Right', pduId: 4, kind: 'panel' }
      }
    }
    const diff = diffImport(defaults, current, {
      app: {
        ...DEFAULT_APP_SETTINGS,
        host: '192.168.85.25',
        sourceMode: 'bridge',
        debugMode: true
      },
      nodeMapping: mapping,
      powerSupply: { mode: 'custom', preset: 'nx650', custom: { a12: 40 } },
      calibration: cal({
        A7: {
          confirmedAt: '2026-10-12T00:00:00Z',
          axes: { 0: axis(412, 2048, 3690), 2: axis(120, 2000, 3980) }
        }
      })
    })
    expect(diff).toEqual([
      {
        id: 'app',
        title: 'App settings',
        summary: '3 changes',
        rows: [
          { k: 'Source mode', from: 'monitor', to: 'bridge' },
          { k: 'DCS host', from: '127.0.0.1', to: '192.168.85.25' },
          { k: 'Debug logging', from: 'Off', to: 'On' }
        ]
      },
      {
        id: 'nodeMapping',
        title: 'Node mapping',
        summary: '3 nodes · 1 joins', // S4: #41 joins your cockpit
        rows: [
          { k: 'Center_Armament · power zone', from: 'PDU_Center', to: 'PDU_Left' },
          { k: 'Right_Navigation · name', from: 'Right_Navigation', to: 'Right_TACAN' },
          { k: '#41', from: 'not in your cockpit', to: 'Right_Oxygen · Right · PDU_Right' }
        ]
      },
      {
        id: 'powerSupply',
        title: 'Power supply',
        summary: '2 changes',
        rows: [
          { k: 'PSU', from: 'NX650 preset', to: 'Custom' },
          { k: 'Custom 12 V rail limit', from: '—', to: '40 A' }
        ]
      },
      {
        id: 'calibration',
        title: 'Axis calibration',
        summary: '1 axis · board A7', // axis 2 is the same: not listed
        rows: [
          { k: 'Axis 0', from: 'not in the copy', to: '412 · 2048 · 3690', axis: 0, board: 'A7' }
        ]
      }
    ])
  })

  it('a file identical to the current setup changes nothing', () => {
    expect(diffImport(defaults, current, current).every((s) => s.rows.length === 0)).toBe(true)
  })
})

describe('applying', () => {
  it('calibration replaces only the axes in the file, per board, and keeps the rest', () => {
    const cache = cal({
      A7: { confirmedAt: '2026-10-14T00:00:00Z', axes: { 0: axis(1, 2, 3), 2: axis(10, 20, 30) } },
      B2: { confirmedAt: '2026-10-01T00:00:00Z', axes: { 1: axis(4, 5, 6) } }
    })
    const merged = mergeCalibration(
      cache,
      cal({
        A7: { confirmedAt: '2026-10-12T00:00:00Z', axes: { 2: axis(11, 21, 31) } },
        C3: { confirmedAt: '2026-10-12T00:00:00Z', axes: { 3: axis(7, 8, 9) } }
      })
    )
    expect(merged.boards).toEqual({
      A7: { confirmedAt: '2026-10-14T00:00:00Z', axes: { 0: axis(1, 2, 3), 2: axis(11, 21, 31) } },
      B2: cache.boards.B2,
      C3: { confirmedAt: '2026-10-12T00:00:00Z', axes: { 3: axis(7, 8, 9) } }
    })
  })

  it('app settings and the PSU are applied independently', () => {
    const config = { ...DEFAULT_CONFIG, psu: { ...DEFAULT_PSU, mode: 'custom' as const } }
    const imported = {
      app: { ...DEFAULT_APP_SETTINGS, host: '10.0.0.2' },
      powerSupply: DEFAULT_PSU
    }
    const pick = (...ids: SectionId[]) => new Set(ids)
    expect(applyToConfig(config, imported, pick('app'))).toEqual({ ...config, host: '10.0.0.2' })
    expect(applyToConfig(config, imported, pick('powerSupply'))).toEqual({
      ...config,
      psu: DEFAULT_PSU
    })
    expect(applyToConfig(config, imported, pick())).toBe(config)
  })
})
