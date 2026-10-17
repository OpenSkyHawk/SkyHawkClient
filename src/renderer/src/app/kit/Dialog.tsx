import { useRef, type ReactNode } from 'react'
import { useModalFocus } from './use-modal-focus'

/**
 * Modal review dialog (Settings › reset / registry). Esc and the scrim close it; Tab stays inside;
 * focus goes to the first control on open and back to whatever opened it on close.
 */
export function Dialog({
  label,
  title,
  sub,
  width,
  onClose,
  footer,
  children
}: {
  label: string
  title: string
  sub: string
  width: number
  onClose: () => void
  footer: ReactNode
  children: ReactNode
}) {
  const ref = useRef<HTMLElement>(null)
  useModalFocus(ref, onClose)

  return (
    <>
      <div className="im__scrim" onClick={onClose} />
      <section
        ref={ref}
        className="im"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        style={{ width: `min(${width}px, calc(100% - 32px))` }}
      >
        <div className="im__h">
          <div>
            <div className="im__t">{title}</div>
            <div className="im__s">{sub}</div>
          </div>
          <button className="toolbtn" style={{ marginLeft: 'auto' }} onClick={onClose}>
            Close
          </button>
        </div>
        <div className="im__b">{children}</div>
        <div className="im__f">{footer}</div>
      </section>
    </>
  )
}
