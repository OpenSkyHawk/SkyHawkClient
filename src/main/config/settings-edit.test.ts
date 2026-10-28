// R3.3: the settings forms' save, built in main (store.ts buildConfig before), and the settings
// pushed back on `config:changed`.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  PSU_VIEW_DEFAULT,
  type ConfigChanged,
  type SectionDiff
} from '@shared/config'
import { storePaths } from '../app/user-data'
import { withSectionNotes } from './config-file'
import {
  buildConfig,
  COMMAND_PORT_ERROR,
  commandPortOf,
  editedConfig,
  formOf,
  savedEdit,
  withPsuLimit
} from './settings-form'
import { SettingsService } from './settings-service'

describe('the forms’ save (buildConfig)', () => {
  it('saves every field the forms edit', () => {
    const form = formOf(DEFAULT_CONFIG)
    expect(buildConfig({ ...form, commandPort: 7779 }).commandPort).toBe(7779)
    expect(Object.keys(buildConfig(form)).sort()).toEqual(
      [
        'attentionBanner',
        'autoConnect',
        'checkFirmwareOnLaunch',
        'commandPort',
        'debugMode',
        'host',
        'psu',
        'replayDriveSerial',
        'sourceMode',
        'transport'
      ].sort()
    )
  })

  it('read-modify-write: a change over the settings held, the rest as saved', () => {
    const current = { ...DEFAULT_CONFIG, host: '10.0.0.7', commandPort: 7790 }
    expect(editedConfig(current, { sourceMode: 'bridge' })).toMatchObject({
      sourceMode: 'bridge',
      host: '10.0.0.7',
      commandPort: 7790
    })
    expect(editedConfig(current, {})).toEqual(buildConfig(formOf(current)))
  })

  it('N5: the command port as typed is a port only as whole digits, 1–65535', () => {
    expect(commandPortOf('7779')).toBe(7779)
    expect(commandPortOf(' 7779 ')).toBe(7779)
    expect(commandPortOf('1')).toBe(1)
    expect(commandPortOf('65535')).toBe(65535)
    for (const junk of ['', ' ', '77a', 'abc', '0', '65536', '-1', '7778.5', '1e3', '0x1f']) {
      expect(commandPortOf(junk), junk).toBeUndefined()
    }
  })

  it('N5: a junk port is refused with its error, never saved as 7778', () => {
    const current = { ...DEFAULT_CONFIG, host: '10.0.0.7', commandPort: 7790 }
    for (const junk of ['', '77a', 'abc', '0', '70000']) {
      expect(savedEdit(current, { port: junk }), junk).toEqual({
        ok: false,
        error: COMMAND_PORT_ERROR
      })
    }
    expect(savedEdit(current, { port: '7781' })).toEqual({
      ok: true,
      save: editedConfig(current, { commandPort: 7781 })
    })
    expect(savedEdit(current, { host: '10.0.0.9' })).toMatchObject({
      ok: true,
      save: { host: '10.0.0.9', commandPort: 7790 }
    })
  })

  it('a PSU mode switch keeps the preset and the custom limits (R3.4a: `{ ...psu, mode }`)', () => {
    const psu = { mode: 'preset' as const, preset: 'nx650' as const, custom: { a12: 40, w: 500 } }
    const current = { ...DEFAULT_CONFIG, psu }
    expect(editedConfig(current, { psuMode: 'custom' }).psu).toEqual({ ...psu, mode: 'custom' })
    const custom = { ...current, psu: { ...psu, mode: 'custom' as const } }
    expect(editedConfig(custom, { psuMode: 'preset' }).psu).toEqual(psu)
    expect(Object.keys(editedConfig(current, { psuMode: 'custom' }))).not.toContain('psuMode')
  })

  it('a PSU limit as typed: refused, removed when empty, set otherwise (R3.4a: onType)', () => {
    const psu = { mode: 'custom' as const, preset: 'nx650' as const, custom: { a12: 40, w: 500 } }
    expect(withPsuLimit(psu, 'a5', '15')).toEqual({ ...psu, custom: { a12: 40, a5: 15, w: 500 } })
    expect(withPsuLimit(psu, 'a12', '')).toEqual({ ...psu, custom: { w: 500 } })
    expect(withPsuLimit(psu, 'a12', '  ')).toEqual({ ...psu, custom: { w: 500 } })
    for (const junk of ['abc', '-5', '0', '20000', '1e3', '4.']) {
      expect(withPsuLimit(psu, 'w', junk), junk).toBeUndefined()
    }
    expect(psu.custom, 'the setting held is never changed in place').toEqual({ a12: 40, w: 500 })
    const current = { ...DEFAULT_CONFIG, psu }
    expect(savedEdit(current, { psuLimit: { key: 'w', text: '400' } })).toMatchObject({
      ok: true,
      save: { psu: { ...psu, custom: { a12: 40, w: 400 } } }
    })
    expect(
      savedEdit(current, { psuLimit: { key: 'w', text: 'x' } }),
      'nothing to save, quietly'
    ).toEqual({ ok: false })
    expect(savedEdit(current, { host: 'h' })).toEqual({
      ok: true,
      save: editedConfig(current, { host: 'h' })
    })
  })
})

describe('SettingsService: edits saved and pushed back (config:changed)', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skyhawk-settings-edit-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function service() {
    const pushed: ConfigChanged[] = []
    const s = new SettingsService({
      paths: storePaths(() => dir),
      debugMode: () => {},
      emit: (_ch, payload) => pushed.push(payload)
    })
    return { s, pushed }
  }

  it('an edit is built over the settings, saved, and comes back as an edit', () => {
    const { s, pushed } = service()
    s.update({ host: '10.0.0.7' })
    const r = s.edit({ port: '7781' })
    expect(r).toMatchObject({ ok: true, config: { host: '10.0.0.7', commandPort: 7781 } })
    const cfg = s.get()
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).toMatchObject({
      commandPort: 7781
    })
    expect(pushed).toEqual([{ config: cfg, psu: PSU_VIEW_DEFAULT, source: 'edit' }])
  })

  it('a refused PSU limit saves nothing and pushes nothing (R3.4a)', () => {
    const { s, pushed } = service()
    s.edit({ psu: { mode: 'custom', preset: 'nx650', custom: { w: 400 } } })
    const before = readFileSync(join(dir, 'config.json'), 'utf8')
    expect(s.edit({ psuLimit: { key: 'w', text: '40x' } })).toEqual({ ok: false })
    expect(pushed).toHaveLength(1)
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(before)
    s.edit({ psuLimit: { key: 'w', text: '' } })
    expect(pushed.at(-1)?.config.psu.custom).toEqual({})
  })

  it('N5: a junk port answers why, and saves and pushes nothing', () => {
    const { s, pushed } = service()
    s.edit({ port: '7781' })
    const before = readFileSync(join(dir, 'config.json'), 'utf8')
    expect(s.edit({ port: '77a' })).toEqual({ ok: false, error: COMMAND_PORT_ERROR })
    expect(s.get().commandPort).toBe(7781)
    expect(pushed).toHaveLength(1)
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(before)
  })

  it('the power supply comes back resolved; an import says so, once it is applied', () => {
    const { s, pushed } = service()
    s.edit({ psu: { mode: 'custom', preset: 'nx650', custom: { w: 400 } } })
    expect(pushed.at(-1)?.psu).toMatchObject({ name: 'PSU', limits: { w: 400 } })
    s.apply({ host: '10.0.0.2' }, false)
    expect(pushed, 'an import’s own save is not pushed').toHaveLength(1)
    s.imported()
    expect(pushed.at(-1)).toMatchObject({ source: 'import', config: { host: '10.0.0.2' } })
    expect(s.view()).toEqual({ config: s.get(), psu: pushed.at(-1)!.psu })
  })
})

describe('the import review’s section notes (ImportDialog.tsx before R3.3)', () => {
  const sec = (id: SectionDiff['id'], rows: number): SectionDiff => ({
    id,
    title: id,
    summary: '',
    rows: Array.from({ length: rows }, () => ({ k: 'k', from: 'a', to: 'b' }))
  })

  it('a changing calibration section says it never writes to the device; nothing else does', () => {
    const out = withSectionNotes([sec('calibration', 2), sec('calibration', 0), sec('app', 1)])
    expect(out[0]!.note).toMatch(/^Adds these values to the client’s calibration copy/)
    expect(out[1]!.note).toBeUndefined()
    expect(out[2]!.note).toBeUndefined()
  })
})
