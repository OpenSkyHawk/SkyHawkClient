import { describe, expect, it } from 'vitest'
import {
  applyToConfig,
  buildConfigFile,
  diffImport,
  mergeCalibration,
  parseConfigFile
} from './config-file'
import { CONFIG_FORMAT, DEFAULT_CONFIG, type ConfigSnapshot, type SectionId } from './config/ipc'
import { registryDefaults } from './node-mapping'
import { DEFAULT_PSU, type NodeMappingFile } from './nodes/ipc'
import type { CalCache } from './hid/calibration/ipc'
import { DEFAULT_APP_SETTINGS } from '../test-fixtures/config'

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
        skipped: []
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
          powerSupply: { mode: 'custom', custom: { a12: 40 } },
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
        skipped: ['macros', 'app']
      }
    })
  })

  it('every section goes through its store’s own sanitizer', () => {
    const r = parseConfigFile(
      JSON.stringify({
        format: CONFIG_FORMAT,
        version: 1,
        sections: {
          app: { host: '', commandPort: 'x', psu: { mode: 'custom' }, debugMode: true },
          nodeMapping: { nodes: { 99: { name: 'out of range' } }, ignored: [3, 'x'] },
          calibration: {
            version: 1,
            boards: { A7: { confirmedAt: 'x', axes: { 1: axis(5, 4, 3) } } }
          }
        }
      })
    )
    expect(r.ok && r.config.sections).toEqual({
      app: { ...DEFAULT_APP_SETTINGS, debugMode: true }, // no psu inside the app section
      nodeMapping: { version: 3, nodes: {} }, // a v1 ignore list is dropped (#93)
      calibration: cal({}) // min < centre < max or nothing
    })
  })
})

describe('diffImport', () => {
  it('the review matches the apply: no "hidden" row for a board on the bus (#93 re-review K)', () => {
    const cur: ConfigSnapshot = {
      ...current,
      nodeMapping: { version: 3, nodes: { 2: { added: true } } }
    }
    const next = { nodeMapping: { version: 3 as const, nodes: { 2: { hidden: true } } } }
    expect(diffImport(defaults, cur, next, [2])[0]!.rows).toEqual([])
    expect(diffImport(defaults, cur, next, [])[0]!.rows).toEqual([
      { k: 'Right_Navigation · hidden', from: 'no', to: 'yes' }
    ])
  })

  it('an import keeps each board’s observed state: nothing to review for it (#93)', () => {
    const seen = '2026-10-14T21:14:00.000Z'
    const cur: ConfigSnapshot = {
      ...current,
      nodeMapping: { version: 3, nodes: { 2: { added: true, lastSeen: seen } } }
    }
    // An older export without the marker or last-seen: applying it keeps 2 in your cockpit.
    const diff = diffImport(defaults, cur, { nodeMapping: { version: 3, nodes: {} } })
    expect(diff).toEqual([
      { id: 'nodeMapping', title: 'Node mapping', summary: '0 nodes', rows: [] }
    ])
    // An adopted board leaving your cockpit is listed.
    const withTrim: ConfigSnapshot = {
      ...cur,
      nodeMapping: {
        version: 3,
        nodes: { 41: { name: 'Trim', console: 'Left', pduId: null, kind: 'panel', lastSeen: seen } }
      }
    }
    expect(
      diffImport(defaults, withTrim, { nodeMapping: { version: 3, nodes: {} } })[0]!.rows
    ).toEqual([{ k: '#41', from: 'Trim · Left · —', to: 'not in your cockpit' }])
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
        summary: '3 nodes',
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
