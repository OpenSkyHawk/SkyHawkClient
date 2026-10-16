import { useEffect, useRef, type ReactNode } from 'react'

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

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
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const box = ref.current
    const items = () => [...(box?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
    ;(items()[0] ?? box)?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close.current()
      } else if (e.key === 'Tab') {
        const list = items()
        if (list.length === 0) return e.preventDefault()
        const i = list.indexOf(document.activeElement as HTMLElement)
        const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i + 1) % list.length
        e.preventDefault()
        list[next]!.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      opener?.focus()
    }
  }, [])

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
