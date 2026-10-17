import { useState } from 'react'
import type { BackupEntry, ConfigImportOpen, ImportPreview } from '@shared/config'
import { Row, SectionHead } from '../app/kit'
import { AutomaticBackups } from './AutomaticBackups'
import { ImportDialog } from './ImportDialog'
import { importDoneText, restoreDoneText } from './import-view'
import { useConfigStore } from './store'

type Note = { text: string; err?: boolean }

/** Settings › Configuration. `axisLabels` name the calibration rows of an import's review. */
export function ConfigurationSection({ axisLabels }: { axisLabels: readonly string[] }) {
  const [exported, setExported] = useState<Note>()
  const [imported, setImported] = useState<Note>()
  const [preview, setPreview] = useState<ImportPreview>()

  const doExport = async () => {
    setExported(undefined)
    // What came of it is ConfigTransfer's to say (R3.4a); the wording is the row's.
    const r = await useConfigStore.getState().exportConfig()
    if (r?.outcome === 'failed') setExported({ text: r.error, err: true })
    else if (r?.outcome === 'saved') setExported({ text: `Saved ${r.path.split(/[/\\]/).pop()}` })
  }

  /** The review of what main read: an import's file, or a backup's for a restore. */
  const review = (r: ConfigImportOpen | undefined) => {
    if (r?.status === 'error') setImported({ text: r.error, err: true })
    else if (r?.status === 'ready') setPreview(r.preview)
  }

  const doImport = async () => {
    setImported(undefined)
    review(await useConfigStore.getState().openConfigImport())
  }

  const doRestore = async (entry: BackupEntry) => {
    setImported(undefined)
    review(await useConfigStore.getState().openConfigBackup(entry.file))
  }

  return (
    <>
      <SectionHead
        title="Configuration"
        desc="Move this client’s setup to another computer, or keep a backup."
      />
      <div className="set-card">
        <Row
          k="Export configuration"
          sub={
            (!exported?.err && exported?.text) ||
            'App settings, node mapping, power supply and axis calibration in one file'
          }
        >
          <button className="browse" onClick={() => void doExport()}>
            Export…
          </button>
        </Row>
        <Row
          k="Import configuration"
          sub={
            (!imported?.err && imported?.text) ||
            'Review what a saved file would change, then apply the parts you pick'
          }
        >
          <button className="browse" onClick={() => void doImport()}>
            Import…
          </button>
        </Row>
      </div>
      {[exported, imported].map(
        (n, i) =>
          n?.err && (
            <div className="set-err" style={{ margin: '10px 2px 0' }} key={i}>
              {n.text}
              {i === 1 ? ' Nothing was changed.' : ''}
            </div>
          )
      )}
      <AutomaticBackups onRestore={(entry) => void doRestore(entry)} />
      {preview && (
        <ImportDialog
          preview={preview}
          axisLabels={axisLabels}
          onClose={() => setPreview(undefined)}
          onApplied={(r) => {
            // The settings come back on `config:changed` (R3.3), the backups on `config:backups`.
            const backedUp = r.backupPath !== undefined
            setImported({
              text: preview.backup
                ? restoreDoneText(preview.backup.savedAt, backedUp)
                : importDoneText(r.applied.length, backedUp)
            })
            setPreview(undefined)
          }}
        />
      )}
    </>
  )
}
