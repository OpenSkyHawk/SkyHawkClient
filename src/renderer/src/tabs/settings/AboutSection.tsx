import { useEffect, useState } from 'react'
import { isLinkUp, type NodeRegistryInfo } from '@shared/ipc'
import { useStore } from '../../store'
import { Dialog } from './Dialog'
import { Row, SectionHead } from './Row'
import { registryOnBus, registrySummary } from './settings-view'
import { useNodeModel } from './useNodeModel'

function RegistryDialog({ reg, onClose }: { reg: NodeRegistryInfo; onClose: () => void }) {
  const model = useNodeModel()
  const linkUp = useStore((s) => isLinkUp(s.deviceState))
  const file = reg.file.split('/').pop()
  return (
    <Dialog
      label="Node registry"
      title="Node registry"
      sub={`${file} @ ${reg.commit.slice(0, 7)} · ${reg.date}`}
      width={560}
      onClose={onClose}
      footer={
        <span className="hint" style={{ margin: 0 }}>
          Read-only. Names and consoles here are the defaults; a node’s own ⚙ settings override them
          on this computer. New NODE_IDs arrive with a client update.
        </span>
      }
    >
      <div className="rg rg--h">
        <span>ID</span>
        <span>Name</span>
        <span>Console</span>
        <span>On the bus</span>
      </div>
      {reg.nodes.map((n) => {
        const bus = registryOnBus(n.nodeId, model, linkUp)
        return (
          <div className="rg" key={n.nodeId}>
            <span className="rg__id">#{n.nodeId}</span>
            <span>{n.name}</span>
            <span className="rg__c">{n.console}</span>
            <span>
              {bus.text !== '—' && (
                <span className={`node__dot rg__dot ${bus.dot}`} aria-hidden="true" />
              )}
              {bus.text}
            </span>
          </div>
        )
      })}
    </Dialog>
  )
}

export function AboutSection() {
  const [reg, setReg] = useState<NodeRegistryInfo>()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void window.skyhawk?.getNodeRegistry().then(setReg)
  }, [])

  return (
    <>
      <SectionHead title="About" />
      <div className="set-card">
        <Row k="Version" sub="OpenSkyhawk Client">
          <span className="set-row__value">v{__APP_VERSION__}</span>
        </Row>
        <Row k="App id" sub="Used for the settings folder">
          <span className="set-row__value">com.openskyhawk.client</span>
        </Row>
        <Row k="License" sub="Free software">
          <span className="set-row__value">GPL-2.0-only</span>
        </Row>
        <Row k="Node registry" sub={reg ? registrySummary(reg) : 'NODE_IDS.md'}>
          <div className="set-row__btns">
            {reg && <span className="set-row__value">{reg.commit.slice(0, 7)}</span>}
            <button className="browse" disabled={!reg} onClick={() => setOpen(true)}>
              View…
            </button>
          </div>
        </Row>
      </div>
      {open && reg && <RegistryDialog reg={reg} onClose={() => setOpen(false)} />}
    </>
  )
}
