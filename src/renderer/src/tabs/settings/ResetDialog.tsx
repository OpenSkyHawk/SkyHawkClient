import { useEffect, useState } from 'react'
import type { ResetPreview } from '@shared/node-mapping'
import type { NodeModel } from '@shared/node-rules'
import { Dialog } from './Dialog'
import { resetButtonLabel } from './settings-view'

/**
 * Reset node mapping — a review, never a one-click reset. Lists every field the reset changes,
 * and offers to forget adopted nodes too (off by default). `model` re-fetches the preview when
 * the mapping changes underneath.
 */
export function ResetDialog({ model, onClose }: { model?: NodeModel; onClose: () => void }) {
  const [preview, setPreview] = useState<ResetPreview>()
  const [forget, setForget] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    void window.skyhawk?.previewNodeReset().then(setPreview)
  }, [model])

  const nodes = preview?.nodeCount ?? 0
  const adopted = preview?.adopted ?? []
  const forgetN = forget ? adopted.length : 0
  const canApply = !busy && (nodes > 0 || forgetN > 0)

  const apply = async () => {
    setBusy(true)
    setError(undefined)
    const r = await window.skyhawk?.resetNodeMapping({ forgetAdopted: forget })
    setBusy(false)
    if (r?.ok) onClose()
    else setError(r?.error ?? 'Reset failed')
  }

  const rowCount = preview?.rows.length ?? 0
  return (
    <Dialog
      label="Reset node mapping"
      title="Reset node mapping"
      sub="Back to NODE_IDS.md defaults · this computer only"
      width={620}
      onClose={onClose}
      footer={
        <>
          <span className={error ? 'set-err' : 'hint'} style={{ margin: 0 }}>
            {error ?? 'Hidden boards and the power supply are not changed.'}
          </span>
          <button className="toolbtn" style={{ marginLeft: 'auto' }} onClick={onClose}>
            Cancel
          </button>
          <button className="browse" disabled={!canApply} onClick={() => void apply()}>
            {resetButtonLabel(nodes, forgetN)}
          </button>
        </>
      }
    >
      <div className="im__sec">
        <div className="im__body">
          <div className="im__st">
            Registry nodes that differ
            {rowCount > 0 && (
              <span className="im__sum">{rowCount === 1 ? '1 change' : `${rowCount} changes`}</span>
            )}
          </div>
          {preview && rowCount === 0 && (
            <div className="hint">None — every registry node already matches NODE_IDS.md.</div>
          )}
          {preview?.rows.map((r) => (
            <div className="im__row" key={`${r.nodeId}-${r.field}`}>
              <span>
                {r.node} · {r.field}
              </span>
              <span className="im__old">{r.from}</span>
              <span className="im__arr">→</span>
              <span className="im__new">{r.to}</span>
            </div>
          ))}
        </div>
      </div>
      {adopted.length > 0 && (
        <div className={`im__sec${forget ? '' : ' im__sec--off'}`}>
          <button
            className={`im__chk${forget ? ' on' : ''}`}
            role="checkbox"
            aria-checked={forget}
            aria-label="Also forget adopted nodes"
            onClick={() => setForget(!forget)}
          >
            <span aria-hidden="true">✓</span>
          </button>
          <div className="im__body">
            <div className="im__st">
              Also forget adopted nodes
              <span className="im__sum">
                {adopted.length === 1 ? '1 node' : `${adopted.length} nodes`} · not in the registry
              </span>
            </div>
            {adopted.map((a) => (
              <div className="im__row" key={a.nodeId}>
                <span>
                  #{a.nodeId} {a.name}
                </span>
                <span className="im__old">
                  {a.console} · {a.zone}
                </span>
                <span className="im__arr">→</span>
                <span className="im__new">New on the bus</span>
              </div>
            ))}
            <div className="im__note">
              Adopted nodes have no registry defaults — forgetting them means adopting them again.
              Left unchecked, they stay as they are.
            </div>
          </div>
        </div>
      )}
    </Dialog>
  )
}
