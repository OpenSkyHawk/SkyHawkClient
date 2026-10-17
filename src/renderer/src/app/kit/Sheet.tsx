import { useRef, type ReactNode } from 'react'
import { useModalFocus } from './use-modal-focus'

/**
 * Side panel under the title bar: Esc, the scrim and Close shut it; focus returns to its opener.
 * A column (#93): the header, the board line and the tabs stay put on every tab; only the body
 * under them scrolls — or, with `fill`, a list inside it (the PDU's Feeds) takes what is left.
 */
export function Sheet(props: {
  label: string
  heading: string
  onClose: () => void
  /** Board head, sub-line and tabs: fixed above the body. */
  top: ReactNode
  fill?: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLElement>(null)
  useModalFocus(ref, props.onClose)
  return (
    <>
      <div className="sheet__scrim" onClick={props.onClose} />
      <aside
        ref={ref}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        tabIndex={-1}
      >
        <div className="panel-h sheet__h">
          <span className="section-h">{props.heading}</span>
          <button className="toolbtn" onClick={props.onClose}>
            Close
          </button>
        </div>
        {props.top}
        <div className={`sh__body${props.fill ? ' sh__body--fill' : ''}`}>{props.children}</div>
      </aside>
    </>
  )
}
