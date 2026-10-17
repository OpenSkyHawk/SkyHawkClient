import { useState } from 'react'
import type { ImportPreview } from '@shared/config'
import { configState, useStore } from '../../store'
import { ImportDialog } from './ImportDialog'
import { Row, SectionHead } from './Row'
import { importDoneText } from './settings-view'

type Note = { text: string; err?: boolean }

export function ConfigurationSection() {
  const set = useStore((s) => s.set)
  const [exported, setExported] = useState<Note>()
  const [imported, setImported] = useState<Note>()
  const [preview, setPreview] = useState<ImportPreview>()

  const doExport = async () => {
    setExported(undefined)
    const r = await window.skyhawk?.exportConfig()
    if (r?.error) setExported({ text: r.error, err: true })
    else if (r?.path) setExported({ text: `Saved ${r.path.split(/[/\\]/).pop()}` })
  }

  const doImport = async () => {
    setImported(undefined)
    const r = await window.skyhawk?.openConfigImport()
    if (r?.status === 'error') setImported({ text: r.error, err: true })
    else if (r?.status === 'ready') setPreview(r.preview)
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
      {preview && (
        <ImportDialog
          preview={preview}
          onClose={() => setPreview(undefined)}
          onApplied={(r) => {
            set(configState(r.config))
            setImported({ text: importDoneText(r.applied.length, r.backupPath) })
            setPreview(undefined)
          }}
        />
      )}
    </>
  )
}
