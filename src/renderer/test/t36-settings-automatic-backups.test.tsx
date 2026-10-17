// T36 — Settings › Configuration › Automatic backups (#136): the newest backups main keeps, as it
// pushes them (`config:backups`), Show in Finder, and Restore…, which opens the import review on a
// backup and applies it the same way.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import { DEFAULT_CONFIG, type BackupList } from '@shared/config'
import { appSettings } from '../../main/config/config-file'
import { Settings } from '../src/app/settings/Settings'
import { renderScenario, settle } from './render'
import { configFileText, restorePreview } from './scenarios'
import type { Scenario } from './skyhawk-mock'

/** A local time, as an ISO string: what the rows show it as. */
const local = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).toISOString()
const ALL = ['App settings', 'Node mapping', 'Power supply', 'Axis calibration']
const NEWEST = 'skyhawk-config-2026-10-17T07-49-00-000Z.json'

const LIST: BackupList = {
  keep: 5,
  fileManager: 'finder',
  backups: [
    {
      file: NEWEST,
      savedAt: local(17, 9, 49),
      before: { kind: 'import', fileName: 'skyhawk-config-2026-10-17.json' },
      sections: ALL
    },
    {
      file: 'skyhawk-config-2026-10-16T20-14-00-000Z.json',
      savedAt: local(16, 22, 14),
      before: { kind: 'restore', savedAt: local(15, 19, 3) },
      sections: ['Node mapping']
    },
    // Saved before backups recorded what they were saved before.
    {
      file: 'skyhawk-config-2026-10-15T17-03-00-000Z.json',
      savedAt: local(15, 19, 3),
      sections: ALL
    }
  ]
}

/** The newest backup's file: another DCS host and PSU, saved before importing that file. */
const NEWEST_TEXT = JSON.stringify({
  ...JSON.parse(
    configFileText({
      app: appSettings({ ...DEFAULT_CONFIG, host: '10.0.0.2' }),
      powerSupply: { mode: 'custom', preset: 'nx650', custom: { a12: 40 } }
    })
  ),
  backup: { before: { kind: 'import', fileName: 'skyhawk-config-2026-10-17.json' } }
})

async function openConfiguration(scenario: Scenario = { backups: LIST }) {
  const r = await renderScenario(<Settings />, scenario)
  await r.user.click(screen.getByRole('button', { name: /^Configuration/ }))
  await settle()
  return r
}

/** A backup row's label and description, by its time. */
const row = (when: string) => screen.getByText(when).parentElement!

/** Restore… on the newest backup, with main answering its review. */
async function restoreNewest() {
  const r = await openConfiguration()
  r.sky.openConfigBackup.mockResolvedValueOnce({
    status: 'ready',
    preview: restorePreview(NEWEST_TEXT, NEWEST, LIST.backups[0]!.savedAt)
  })
  await r.user.click(
    screen.getByRole('button', { name: 'Restore the backup from 2026-10-17 09:49' })
  )
  await settle()
  return { ...r, dlg: screen.getByRole('dialog', { name: 'Restore backup' }) }
}

describe('T36 Settings › Configuration › Automatic backups (#136)', () => {
  it('lists the backups main keeps, newest first: when, what they were before, what they hold', async () => {
    const { sky } = await openConfiguration()
    expect(sky.getConfigBackups).toHaveBeenCalled() // pulled again as the section opens
    expect(screen.getByText('Automatic backups').parentElement).toHaveTextContent(
      'Automatic backups3 of 5Show in Finder'
    )
    expect(row('2026-10-17 09:49')).toHaveTextContent(
      'Before importing skyhawk-config-2026-10-17.json · App settings, node mapping, power ' +
        'supply, axis calibration'
    )
    expect(row('2026-10-16 22:14')).toHaveTextContent(
      'Before restoring the backup from 2026-10-15 19:03 · Node mapping'
    )
    expect(row('2026-10-15 19:03')).toHaveTextContent(
      'Before an import · App settings, node mapping, power supply, axis calibration'
    )
    const restores = screen.getAllByRole('button', { name: /^Restore the backup from / })
    expect(restores.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Restore the backup from 2026-10-17 09:49',
      'Restore the backup from 2026-10-16 22:14',
      'Restore the backup from 2026-10-15 19:03'
    ])
    expect(restores[0]).toHaveTextContent('Restore…')
    expect(
      screen.getByText(
        'Saved before each import, in the app’s settings folder. The newest 5 are kept; older ' +
          'ones are removed. Restore shows what it would change first, like an import.'
      )
    ).toBeInTheDocument()
  })

  it('no backups yet: says how one is made, and no count', async () => {
    await openConfiguration({})
    expect(
      screen.getByText(
        'No backups yet. One is saved each time you import with “Save a backup of the current ' +
          'setup first” ticked.'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('Automatic backups').parentElement).toHaveTextContent(
      'Automatic backupsShow in folder'
    )
    expect(screen.queryByRole('button', { name: /^Restore the backup/ })).toBeNull()
  })

  it('follows main’s push: a new backup is listed as it is saved', async () => {
    const { sky } = await openConfiguration({})
    sky.emitScenario({ backups: { ...LIST, backups: LIST.backups.slice(0, 1) } })
    expect(screen.getByText('Automatic backups').parentElement).toHaveTextContent('1 of 5')
    expect(row('2026-10-17 09:49')).toBeInTheDocument()
    expect(screen.queryByText(/^No backups yet/)).toBeNull()
  })

  it('Show in Finder asks main to open the folder; on Windows it says Explorer', async () => {
    const { sky, user } = await openConfiguration()
    await user.click(screen.getByRole('button', { name: 'Show in Finder' }))
    expect(sky.revealConfigBackups).toHaveBeenCalledTimes(1)
    sky.emitScenario({ backups: { ...LIST, fileManager: 'explorer' } })
    expect(screen.getByRole('button', { name: 'Show in Explorer' })).toBeInTheDocument()
  })

  it('Restore… opens the import review on the backup, titled as a restore', async () => {
    const { sky, dlg } = await restoreNewest()
    expect(sky.openConfigBackup).toHaveBeenCalledWith(NEWEST)
    expect(
      within(dlg).getByText(
        'Automatic backup · 2026-10-17 09:49 · saved before importing skyhawk-config-2026-10-17.json'
      )
    ).toBeInTheDocument()
    expect(within(dlg).getByText('DCS host').parentElement).toHaveTextContent(
      'DCS host127.0.0.1→10.0.0.2'
    )
    expect(within(dlg).getByRole('checkbox', { name: /backup/ })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(within(dlg).getByRole('button', { name: 'Restore 2 sections' })).toBeEnabled()
    expect(screen.queryByRole('dialog', { name: 'Import configuration' })).toBeNull()
  })

  it('restored with the box ticked: the setup before it was backed up first', async () => {
    const { sky, user, dlg } = await restoreNewest()
    sky.applyConfigImport.mockResolvedValueOnce({
      ok: true,
      applied: ['app', 'powerSupply'],
      backupPath: '/u/backups/skyhawk-config-2026-10-17T08-00-00-000Z.json',
      config: { ...DEFAULT_CONFIG, host: '10.0.0.2' }
    })
    await user.click(within(dlg).getByRole('button', { name: 'Restore 2 sections' }))
    await settle()
    expect(sky.applyConfigImport).toHaveBeenCalledWith(
      'restore-token-1',
      ['app', 'powerSupply'],
      true
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(
      screen.getByText(
        'Restored the backup from 2026-10-17 09:49 · the setup before it was backed up first'
      )
    ).toBeInTheDocument()
  })

  it('restored with the box unticked: no backup taken, and the line says only what was done', async () => {
    const { sky, user, dlg } = await restoreNewest()
    sky.applyConfigImport.mockResolvedValueOnce({
      ok: true,
      applied: ['app', 'powerSupply'],
      config: { ...DEFAULT_CONFIG, host: '10.0.0.2' }
    })
    await user.click(within(dlg).getByRole('checkbox', { name: /backup/ }))
    await user.click(within(dlg).getByRole('button', { name: 'Restore 2 sections' }))
    await settle()
    expect(sky.applyConfigImport).toHaveBeenCalledWith(
      'restore-token-1',
      ['app', 'powerSupply'],
      false
    )
    expect(screen.getByText('Restored the backup from 2026-10-17 09:49')).toBeInTheDocument()
  })

  it('a backup main can no longer read: its reason, and "Nothing was changed."', async () => {
    const { user } = await openConfiguration()
    await user.click(
      screen.getByRole('button', { name: 'Restore the backup from 2026-10-16 22:14' })
    )
    await settle()
    expect(
      screen.getByText('This backup is no longer in the backups folder. Nothing was changed.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
