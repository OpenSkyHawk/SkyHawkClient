// SESSION-seam contract test (#136, D5 / M6 + X13): the <userData> files as the outside world sees
// them, through the services harness. A file that falls back to its backup, or cannot be saved,
// is a row in the event log (events:get), wired through AppServices to the EventJournal.
import { chmodSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CTRL } from '@shared/app'
import { DEFAULT_CONFIG } from '@shared/config'
import type { LogEvent } from '@shared/events'
import { makeServices, type Services } from '../test-harness/services'

const fileRows = (app: Services, name: string): LogEvent[] =>
  app.invoke(CTRL.eventsGet).filter((e) => e.source === 'client' && e.name === name)

describe('#136 a damaged file comes back from its backup, and the event log says so', () => {
  it('config.json: the settings come back from config.json.bak', () => {
    const app = makeServices({
      paths: {
        files: {
          'config.json': '{"sourceMode":"mon',
          'config.json.bak': { ...DEFAULT_CONFIG, sourceMode: 'bridge', host: '10.0.0.7' }
        }
      }
    })
    expect(app.invoke(CTRL.configGet).config).toMatchObject({
      sourceMode: 'bridge',
      host: '10.0.0.7'
    })
    const bad = app.files.list().find((f) => f.startsWith('config.json.bad-'))
    const detail =
      `config.json is damaged. Loaded the backup, config.json.bak. The bad copy was kept ` +
      `as ${bad}.`
    expect(fileRows(app, 'config.json')).toEqual([
      expect.objectContaining({
        severity: 'warn', // recovered: nothing lost
        event: 'warning', // and labelled so: nothing on the row says "error"
        detail,
        raw: `config.json Warning: ${detail}`
      })
    ])
  })

  it('node-mapping.json: the cockpit comes back from node-mapping.json.bak', () => {
    const app = makeServices({
      paths: {
        files: {
          'node-mapping.json': '{"version":3,"nodes":{"1":{"na',
          'node-mapping.json.bak': { version: 3, nodes: { 1: { name: 'Trim', added: true } } }
        }
      }
    })
    const trim = app.invoke(CTRL.nodesGet).model.nodes.find((n) => n.nodeId === 1)
    expect(trim).toMatchObject({ name: 'Trim' })
    const bad = app.files.list().find((f) => f.startsWith('node-mapping.json.bad-'))
    expect(fileRows(app, 'node-mapping.json').map((e) => `${e.severity} ${e.detail}`)).toEqual([
      `warn node-mapping.json is damaged. Loaded the backup, node-mapping.json.bak. The bad copy was ` +
        `kept as ${bad}.`
    ])
    // Writable: a rename saves, and the file it replaces becomes the backup.
    expect(app.invoke(CTRL.nodeMappingSet, 1, { name: 'Trim L' })).toMatchObject({ ok: true })
    expect(app.files.json('node-mapping.json')).toMatchObject({ nodes: { 1: { name: 'Trim L' } } })
    expect(app.files.json('node-mapping.json.bak')).toMatchObject({
      nodes: { 1: { name: 'Trim' } }
    })
  })

  it.skipIf(process.getuid?.() === 0)(
    'a settings change that cannot be saved still applies, and is one row however often it fails',
    () => {
      const app = makeServices({ paths: { files: { 'config.json': DEFAULT_CONFIG } } })
      chmodSync(app.files.dir, 0o500) // read-only <userData>
      try {
        expect(app.invoke(CTRL.configSet, { host: '10.0.0.8' }).host).toBe('10.0.0.8')
        app.invoke(CTRL.configSet, { host: '10.0.0.9' })
        expect(app.invoke(CTRL.configGet).config.host).toBe('10.0.0.9')
        const rows = fileRows(app, 'config.json')
        expect(rows).toHaveLength(1)
        expect(rows[0]!.severity).toBe('error')
        expect(rows[0]!.detail).toBe(
          `config.json could not be saved (permission denied in ${app.files.dir})`
        )
      } finally {
        chmodSync(app.files.dir, 0o700)
      }
    }
  )
})
