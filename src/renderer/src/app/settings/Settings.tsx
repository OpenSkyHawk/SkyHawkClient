import { useState } from 'react'
import { ConfigurationSection } from '../../config'
import { AXIS_LABELS } from '../../hid'
import { AboutSection } from './AboutSection'
import { CockpitSection } from './CockpitSection'
import { ConnectionSection } from './ConnectionSection'
import { DiagnosticsSection } from './DiagnosticsSection'

type SectionId = 'connection' | 'cockpit' | 'config' | 'diag' | 'about'

const SECTIONS: { id: SectionId; label: string; sub: string }[] = [
  { id: 'connection', label: 'Connection', sub: 'DCS link, ports' },
  { id: 'cockpit', label: 'Cockpit', sub: 'PSU, mapping, alerts' },
  { id: 'config', label: 'Configuration', sub: 'export / import' },
  { id: 'diag', label: 'Diagnostics', sub: 'logs' },
  { id: 'about', label: 'About', sub: 'version, registry' }
]

/** Settings: sections on the left (a row below 820 px), the picked one on the right. */
export function Settings() {
  const [section, setSection] = useState<SectionId>('connection')

  return (
    <div className="sv">
      <nav className="sn" aria-label="Settings sections">
        {SECTIONS.map((x) => (
          <button
            key={x.id}
            className={`sn__i${section === x.id ? ' on' : ''}`}
            aria-current={section === x.id ? 'page' : undefined}
            onClick={() => setSection(x.id)}
          >
            <span className="sn__l">{x.label}</span>
            <span className="sn__s">{x.sub}</span>
          </button>
        ))}
      </nav>
      <div className="sp">
        {section === 'connection' && <ConnectionSection />}
        {section === 'cockpit' && <CockpitSection />}
        {section === 'config' && <ConfigurationSection axisLabels={AXIS_LABELS} />}
        {section === 'diag' && <DiagnosticsSection />}
        {section === 'about' && <AboutSection />}
      </div>
    </div>
  )
}
