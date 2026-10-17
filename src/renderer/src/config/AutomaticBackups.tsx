import { useEffect } from 'react'
import type { BackupEntry } from '@shared/config'
import {
  BACKUPS_EMPTY,
  backupCount,
  backupDesc,
  backupHint,
  backupWhen,
  showFolderLabel
} from './backups-view'
import { useConfigStore } from './store'

/**
 * Settings › Configuration › Automatic backups (#136): the newest backups main keeps, each with
 * Restore…, which opens the import review on it (`onRestore`), and Show in Finder.
 */
export function AutomaticBackups({ onRestore }: { onRestore: (entry: BackupEntry) => void }) {
  const list = useConfigStore((s) => s.backups)
  const revealConfigBackups = useConfigStore((s) => s.revealConfigBackups)

  // The list as it is on disk when the section opens: a backup deleted by hand drops off.
  useEffect(() => {
    useConfigStore.getState().loadConfigBackups()
  }, [])

  return (
    <>
      <div className="ig__head">
        <span className="section-h">Automatic backups</span>
        <span className="ig__n">{backupCount(list)}</span>
        <button
          className="toolbtn"
          style={{ marginLeft: 'auto' }}
          onClick={() => revealConfigBackups()}
        >
          {showFolderLabel(list.fileManager)}
        </button>
      </div>
      <div className="set-card">
        {list.backups.map((b) => (
          <div className="set-row" key={b.file}>
            <div style={{ flex: 1 }}>
              <div className="set-row__label">{backupWhen(b.savedAt)}</div>
              <div className="set-row__desc">{backupDesc(b)}</div>
            </div>
            <div>
              <button
                className="browse"
                aria-label={`Restore the backup from ${backupWhen(b.savedAt)}`}
                onClick={() => onRestore(b)}
              >
                Restore…
              </button>
            </div>
          </div>
        ))}
        {list.backups.length === 0 && (
          <div className="set-row">
            <div className="set-row__desc">{BACKUPS_EMPTY}</div>
          </div>
        )}
      </div>
      <div className="hint" style={{ margin: '10px 2px 0' }}>
        {backupHint(list.keep)}
      </div>
    </>
  )
}
