import type { ReactNode } from 'react'

export function Row({ k, sub, children }: { k: string; sub: string; children: ReactNode }) {
  return (
    <div className="set-row">
      <div>
        <div className="set-row__label">{k}</div>
        <div className="set-row__desc">{sub}</div>
      </div>
      <div>{children}</div>
    </div>
  )
}

/** A section's title and one-line description, above its cards. */
export function SectionHead({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="sp__head">
      <h2 className="sp__t">{title}</h2>
      {desc && <div className="sp__d">{desc}</div>}
    </div>
  )
}
