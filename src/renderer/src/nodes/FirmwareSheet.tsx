import { useState, type ReactNode } from 'react'
import type { FirmwareSheet as FirmwareSheetData } from '@shared/nodes'
import { Chevron, Sheet } from '../app/kit'
import { firmwareHint, firmwareNone, firmwareRowView } from './firmware-view'

/**
 * The Cockpit's Firmware sheet (#173): the release card, then every board against the release —
 * *Needs attention* first, or *All*. Main decides each row (`cockpit:snapshot` firmware); this
 * only words it. `releaseCard` is the release check's card (releases, #192), handed in by the app.
 */
export function FirmwareSheet(props: {
  sheet: FirmwareSheetData
  releaseCard: ReactNode
  onOpen: (nodeId: number) => void
  /** A row's *Update*: the update dialog on that board (the app opens it, #173). */
  onUpdate: (row: string) => void
  onClose: () => void
}) {
  const { sheet } = props
  const [all, setAll] = useState(false)
  const rows = (all ? sheet.rows : sheet.rows.filter((r) => r.attention)).map((r) =>
    firmwareRowView(r, sheet.target)
  )
  return (
    <Sheet
      label="Firmware"
      heading="Firmware"
      onClose={props.onClose}
      top={
        <>
          {props.releaseCard}
          <div className="fw__bar">
            <div className="segmini" role="group" aria-label="Show">
              <button className={all ? '' : 'on'} aria-pressed={!all} onClick={() => setAll(false)}>
                Needs attention · {sheet.attention}
              </button>
              <button className={all ? 'on' : ''} aria-pressed={all} onClick={() => setAll(true)}>
                All · {sheet.rows.length}
              </button>
            </div>
          </div>
        </>
      }
    >
      <div className="sh__sec">
        {rows.length > 0 && (
          <ul className="evt att sh__list" aria-label="Boards">
            {rows.map((r) => (
              <li key={r.key} className="fw__li fw__row">
                <span className={`node__dot ${r.dot}${r.sym ? ' sym' : ''}`} aria-hidden="true">
                  {r.sym}
                </span>
                <span className="fw__who">
                  <b className="fw__nm" title={r.name}>
                    {r.name}
                  </b>
                  <span className="fw__meta">
                    {r.chip && <span className={`vchip ${r.chipCls}`}>{r.chip}</span>}
                    <span>{r.sub}</span>
                  </span>
                </span>
                {r.update && (
                  <button className="toolbtn" onClick={() => props.onUpdate(r.key)}>
                    Update
                  </button>
                )}
                {r.opens !== undefined && (
                  <button
                    className="cog"
                    title={`Open ${r.name}`}
                    aria-label={`Open ${r.name}`}
                    onClick={() => props.onOpen(r.opens!)}
                  >
                    <Chevron />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {rows.length === 0 && <div className="hint">{firmwareNone(sheet)}</div>}
        <div className="hint" style={{ marginTop: 8 }}>
          {firmwareHint(sheet)}
        </div>
      </div>
    </Sheet>
  )
}
