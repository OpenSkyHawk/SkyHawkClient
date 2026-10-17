import { useState } from 'react'
import type { ConfigImportApplyResult, ImportPreview, SectionId } from '@shared/config'
import { Dialog } from '../app/kit'
import { identicalText, importRowKey, importSubtitle } from './import-view'
import { useConfigStore } from './store'

/**
 * Import configuration — review what the file changes, section by section, and apply the ones
 * ticked. Sections with no change are shown but cannot be picked; a file that changes nothing
 * says so and offers no Apply. A section main rejected (malformed or incomplete) is listed as
 * skipped with main's reason, and one from a newer client as skipped too. `axisLabels` name the
 * calibration rows.
 */
export function ImportDialog({
  preview,
  axisLabels,
  onClose,
  onApplied
}: {
  preview: ImportPreview
  axisLabels: readonly string[]
  onClose: () => void
  onApplied: (r: Extract<ConfigImportApplyResult, { ok: true }>) => void
}) {
  const changing = preview.sections.filter((s) => s.rows.length > 0).map((s) => s.id)
  const [picked, setPicked] = useState<Set<SectionId>>(() => new Set(changing))
  const [backup, setBackup] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const toggle = (id: SectionId) => {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
  }

  const apply = async () => {
    setBusy(true)
    setError(undefined)
    const r = await useConfigStore.getState().applyConfigImport(preview.token, [...picked], backup)
    setBusy(false)
    if (r?.ok) onApplied(r)
    else setError(r?.error ?? 'Import failed')
  }

  const n = picked.size
  return (
    <Dialog
      label="Import configuration"
      title="Import configuration"
      sub={importSubtitle(preview)}
      width={720}
      onClose={onClose}
      footer={
        preview.identical ? (
          <>
            <span className="hint" style={{ margin: 0 }}>
              Nothing to apply.
            </span>
            <button className="toolbtn" style={{ marginLeft: 'auto' }} onClick={onClose}>
              Close
            </button>
          </>
        ) : (
          <>
            {error ? (
              <span className="set-err">{error}</span>
            ) : (
              <button
                className="bk"
                role="checkbox"
                aria-checked={backup}
                onClick={() => setBackup(!backup)}
              >
                <span className={`im__chk${backup ? ' on' : ''}`} aria-hidden="true">
                  <span>✓</span>
                </span>
                Save a backup of the current setup first
              </button>
            )}
            <button className="toolbtn" style={{ marginLeft: 'auto' }} onClick={onClose}>
              Cancel
            </button>
            <button className="browse" disabled={busy || n === 0} onClick={() => void apply()}>
              Apply {n === 1 ? '1 section' : `${n} sections`}
            </button>
          </>
        )
      }
    >
      {preview.identical && (
        <div className="im__sec">
          <div className="im__body">
            <div className="im__st">{identicalText(preview)}</div>
          </div>
        </div>
      )}
      {!preview.identical &&
        preview.sections.map((s) => {
          const on = picked.has(s.id)
          const none = s.rows.length === 0
          const boards = new Set(s.rows.map((r) => r.board).filter(Boolean))
          return (
            <div className={`im__sec${on ? '' : ' im__sec--off'}`} key={s.id}>
              <button
                className={`im__chk${on ? ' on' : ''}`}
                role="checkbox"
                aria-checked={on}
                aria-label={s.title}
                disabled={none}
                onClick={() => toggle(s.id)}
              >
                <span aria-hidden="true">✓</span>
              </button>
              <div className="im__body">
                <div className="im__st">
                  {s.title}
                  <span className="im__sum">{none ? 'no change' : s.summary}</span>
                </div>
                {s.rows.map((r, i) => (
                  <div className="im__row" key={i}>
                    <span>{importRowKey(r, axisLabels, boards.size > 1)}</span>
                    <span className="im__old">{r.from}</span>
                    <span className="im__arr">→</span>
                    <span className="im__new">{r.to}</span>
                  </div>
                ))}
                {s.note && <div className="im__note">{s.note}</div>}
              </div>
            </div>
          )
        })}
      {preview.rejected.map((s) => (
        <div className="im__note" style={{ margin: '12px 0' }} key={s.id}>
          {`Skipped — ${s.title}: ${s.reason}.`}
        </div>
      ))}
      {preview.skipped.length > 0 && (
        <div className="im__note" style={{ margin: '12px 0' }}>
          Skipped — written by a newer client: {preview.skipped.join(', ')}. Update this client to
          import {preview.skipped.length === 1 ? 'it' : 'them'}.
        </div>
      )}
    </Dialog>
  )
}
