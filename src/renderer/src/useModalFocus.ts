import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Focus handling every modal surface shares (Settings dialogs, Cockpit side panels, Adopt):
 * focus moves to the first control on open, Tab stays inside, Esc closes, and on close focus goes
 * back to whatever opened it.
 */
export function useModalFocus(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
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
  }, [ref])
}
