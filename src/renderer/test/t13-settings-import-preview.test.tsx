// T13 — Settings › Configuration › Import: the review of what a file would change, and Apply.
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import { DEFAULT_CONFIG, type ImportPreview } from '@shared/config'
import { appSettings } from '../../main/config/config-file'
import { registryDefaults } from '../../main/nodes/registry'
import { Settings } from '../src/app/settings/Settings'
import { renderScenario, settle } from './render'
import { configFileText, importPreview, setup } from './scenarios'

/** Exported 12 Oct 2026, 21:02 local time — what the subtitle shows. */
const EXPORTED_AT = new Date(2026, 9, 12, 21, 2).toISOString()

/** A file from another computer: a different DCS host, autoconnect off, a custom 12 V limit. */
const otherSetup = () =>
  configFileText(
    {
      app: appSettings({ ...DEFAULT_CONFIG, host: '10.0.0.2', autoConnect: false }),
      powerSupply: { mode: 'custom', preset: 'nx650', custom: { a12: 40 } }
    },
    EXPORTED_AT
  )

/** Settings › Configuration, Import… pressed with main answering `preview`. */
async function openImport(preview: ImportPreview) {
  const r = await renderScenario(<Settings />)
  r.sky.openConfigImport.mockResolvedValueOnce({ status: 'ready', preview })
  await r.user.click(screen.getByRole('button', { name: /^Configuration/ }))
  await r.user.click(screen.getByRole('button', { name: 'Import…' }))
  await settle()
  const dlg = screen.getByRole('dialog', { name: 'Import configuration' })
  /** A section's tick box, by its title. */
  const tick = (title: string) => within(dlg).getByRole('checkbox', { name: title })
  /** A review row ("key from → to") by its key. */
  const diffRow = (k: string) => within(dlg).getByText(k).parentElement
  return { ...r, dlg, tick, diffRow }
}

describe('T13 Settings › Configuration › Import preview (B90, B94, F1, C1, S4)', () => {
  it('lists each section’s changes as "key from → to", every changing section picked', async () => {
    const { dlg, tick, diffRow } = await openImport(importPreview(otherSetup()))
    expect(
      within(dlg).getByText('skyhawk-config.json · exported 2026-10-12 21:02 · client v0.2.0')
    ).toBeInTheDocument()
    expect(within(dlg).getByText('App settings').parentElement).toHaveTextContent(
      'App settings2 changes'
    )
    expect(diffRow('DCS host')).toHaveTextContent('DCS host127.0.0.1→10.0.0.2')
    expect(diffRow('Connect automatically')).toHaveTextContent('Connect automaticallyOn→Off')
    expect(diffRow('PSU')).toHaveTextContent('PSUNX650 preset→Custom')
    expect(diffRow('Custom 12 V rail limit')).toHaveTextContent('Custom 12 V rail limit—→40 A')
    expect(tick('App settings')).toHaveAttribute('aria-checked', 'true')
    expect(tick('Power supply')).toHaveAttribute('aria-checked', 'true')
    expect(within(dlg).getByRole('checkbox', { name: /backup/ })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(within(dlg).getByRole('button', { name: 'Apply 2 sections' })).toBeEnabled()
  })

  it('a section that changes nothing reads "no change" and can’t be picked', async () => {
    const text = configFileText(
      {
        app: appSettings({ ...DEFAULT_CONFIG, host: '10.0.0.2' }),
        powerSupply: DEFAULT_CONFIG.psu
      },
      EXPORTED_AT
    )
    const { dlg, tick } = await openImport(importPreview(text))
    expect(within(dlg).getByText('Power supply').parentElement).toHaveTextContent(
      'Power supplyno change'
    )
    expect(tick('Power supply')).toBeDisabled()
    expect(within(dlg).getByRole('button', { name: 'Apply 1 section' })).toBeEnabled()
  })

  it('a file that matches this computer: "This file matches your current setup", no Apply', async () => {
    const same = configFileText(
      {
        app: appSettings(DEFAULT_CONFIG),
        nodeMapping: { version: 3, nodes: {} },
        powerSupply: DEFAULT_CONFIG.psu
      },
      EXPORTED_AT
    )
    const { dlg } = await openImport(importPreview(same))
    expect(within(dlg).getByText('This file matches your current setup')).toBeInTheDocument()
    expect(within(dlg).getByText('Nothing to apply.')).toBeInTheDocument()
    expect(within(dlg).queryByRole('button', { name: /^Apply/ })).toBeNull()
    expect(within(dlg).queryByRole('checkbox')).toBeNull()
  })

  it('an empty "nodeMapping": {} is listed as skipped with its reason, and can’t be picked (F1, C1)', async () => {
    // contract F1: a structurally empty section is refused and listed as skipped — never read as
    // an empty mapping that would take every adopted board out of your cockpit.
    const current = setup({
      nodeMapping: {
        version: 3,
        nodes: { 12: { name: 'Left_Lights', console: 'Left', kind: 'panel', pduId: null } }
      }
    })
    const text = configFileText(
      { nodeMapping: {}, app: appSettings({ ...DEFAULT_CONFIG, host: '10.0.0.2' }) },
      EXPORTED_AT
    )
    const { dlg } = await openImport(importPreview(text, current))
    expect(within(dlg).getByText('Skipped — Node mapping: it has no version.')).toBeInTheDocument()
    expect(within(dlg).queryByRole('checkbox', { name: 'Node mapping' })).toBeNull()
    expect(within(dlg).queryByText('#12')).toBeNull()
    expect(within(dlg).getByRole('button', { name: 'Apply 1 section' })).toBeEnabled()
  })

  it('boards that join and leave your cockpit are listed, as main reviews them (S4)', async () => {
    const defaults = registryDefaults({
      1: { name: 'Center_Armament', console: 'Center' },
      2: { name: 'Right_Navigation', console: 'Right' }
    })
    const current = setup({
      nodeMapping: {
        version: 3,
        nodes: {
          1: { added: true },
          12: { name: 'Left_Lights', console: 'Left', kind: 'panel', pduId: null }
        }
      }
    })
    const text = configFileText(
      { nodeMapping: { version: 3, nodes: { 2: { added: true } } } },
      EXPORTED_AT
    )
    const { dlg, tick, diffRow } = await openImport(importPreview(text, current, defaults))
    expect(within(dlg).getByText('Node mapping').parentElement).toHaveTextContent(
      'Node mapping3 nodes · 1 joins · 2 leave'
    )
    expect(diffRow('Center_Armament')).toHaveTextContent(
      'Center_ArmamentCenter_Armament · Center · —→not in your cockpit'
    )
    expect(diffRow('Right_Navigation')).toHaveTextContent(
      'Right_Navigationnot in your cockpit→Right_Navigation · Right · —'
    )
    expect(diffRow('#12')).toHaveTextContent('#12Left_Lights · Left · —→not in your cockpit')
    expect(tick('Node mapping')).toHaveAttribute('aria-checked', 'true')
  })

  it('a section this client doesn’t know is listed as skipped', async () => {
    const text = configFileText(
      {
        app: appSettings({ ...DEFAULT_CONFIG, host: '10.0.0.2' }),
        panelLayouts: { v: 1 }
      },
      EXPORTED_AT
    )
    const { dlg } = await openImport(importPreview(text))
    expect(
      within(dlg).getByText(
        'Skipped — written by a newer client: panelLayouts. Update this client to import it.'
      )
    ).toBeInTheDocument()
  })

  it('Apply is greyed out with nothing picked', async () => {
    const { dlg, user, tick } = await openImport(importPreview(otherSetup()))
    await user.click(tick('App settings'))
    await user.click(tick('Power supply'))
    expect(tick('App settings')).toHaveAttribute('aria-checked', 'false')
    expect(within(dlg).getByRole('button', { name: 'Apply 0 sections' })).toBeDisabled()
  })

  it('Apply sends the file’s token, the picked sections and the backup choice', async () => {
    const { dlg, sky, user, tick } = await openImport(importPreview(otherSetup()))
    await user.click(tick('Power supply'))
    await user.click(within(dlg).getByRole('checkbox', { name: /backup/ }))
    await user.click(within(dlg).getByRole('button', { name: 'Apply 1 section' }))
    await settle()
    expect(sky.applyConfigImport).toHaveBeenCalledWith('import-token-1', ['app'], false)
  })

  it('applied: the dialog closes and the Import row says what was done', async () => {
    const { dlg, sky, user } = await openImport(importPreview(otherSetup()))
    sky.applyConfigImport.mockResolvedValueOnce({
      ok: true,
      applied: ['app', 'powerSupply'],
      backupPath: '/Users/me/Library/backups/skyhawk-config-backup-2026-10-16.json',
      config: { ...DEFAULT_CONFIG, host: '10.0.0.2', autoConnect: false }
    })
    await user.click(within(dlg).getByRole('button', { name: 'Apply 2 sections' }))
    await settle()
    expect(sky.applyConfigImport).toHaveBeenCalledWith(
      'import-token-1',
      ['app', 'powerSupply'],
      true
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(
      screen.getByText('Applied 2 sections · backup saved as skyhawk-config-backup-2026-10-16.json')
    ).toBeInTheDocument()
  })

  it('a refused apply shows main’s error in the dialog', async () => {
    const { dlg, sky, user } = await openImport(importPreview(otherSetup()))
    sky.applyConfigImport.mockResolvedValueOnce({
      ok: false,
      error: 'That file is no longer open — import it again.'
    })
    await user.click(within(dlg).getByRole('button', { name: 'Apply 2 sections' }))
    await settle()
    expect(
      within(dlg).getByText('That file is no longer open — import it again.')
    ).toBeInTheDocument()
  })

  it('a file main refuses: its reason, and "Nothing was changed."', async () => {
    const { sky, user } = await renderScenario(<Settings />)
    sky.openConfigImport.mockResolvedValueOnce({
      status: 'error',
      error: 'This is not an OpenSkyhawk Client configuration file.'
    })
    await user.click(screen.getByRole('button', { name: /^Configuration/ }))
    await user.click(screen.getByRole('button', { name: 'Import…' }))
    await settle()
    expect(
      screen.getByText('This is not an OpenSkyhawk Client configuration file. Nothing was changed.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
