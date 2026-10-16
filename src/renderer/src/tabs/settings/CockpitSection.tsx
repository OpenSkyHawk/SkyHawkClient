import { useState } from 'react'
import { parsePsuLimit, PSU_PRESETS, type PsuLimits } from '@shared/psu'
import { useStore } from '../../store'
import { ResetDialog } from './ResetDialog'
import { Row, SectionHead } from './Row'
import { hiddenRow, resetRowDesc } from './settings-view'
import { useNodeModel } from './useNodeModel'

type LimitKey = keyof PsuLimits

const LIMITS: { k: LimitKey; label: string; unit: string; custom: string }[] = [
  {
    k: 'a12',
    label: '12 V rail limit',
    unit: 'A',
    custom: 'Combined current of all 12 V outputs (PSU label)'
  },
  {
    k: 'a5',
    label: '5 V rail limit',
    unit: 'A',
    custom: 'Combined current of all 5 V outputs (PSU label)'
  },
  { k: 'w', label: 'Total power', unit: 'W', custom: 'Rated output (PSU label)' }
]

const text = (v: number | undefined) => (v === undefined ? '' : String(v))

function PowerSupply() {
  const psu = useStore((s) => s.psu)
  const setConfigField = useStore((s) => s.setConfigField)
  const preset = PSU_PRESETS[psu.preset]
  const isPreset = psu.mode === 'preset'
  // What is typed, per field: a refused value stays visible (and unsaved) until corrected.
  const [typed, setTyped] = useState<Record<LimitKey, string>>(() => ({
    a12: text(psu.custom.a12),
    a5: text(psu.custom.a5),
    w: text(psu.custom.w)
  }))

  const onType = (k: LimitKey, value: string) => {
    setTyped({ ...typed, [k]: value })
    const n = parsePsuLimit(value)
    if (n === null) return
    const custom = { ...psu.custom }
    if (n === undefined) delete custom[k]
    else custom[k] = n
    setConfigField({ psu: { ...psu, custom } })
  }

  return (
    <>
      <div className="ig__head">
        <span className="section-h">Power supply</span>
        <span className="ig__n">headroom on the Cockpit</span>
      </div>
      <div className="set-card">
        <Row k="PSU" sub="Pick a known supply, or Custom to enter limits by hand">
          <div className="seg psu-seg" role="group" aria-label="Power supply">
            <button
              className={isPreset ? 'on' : ''}
              aria-pressed={isPreset}
              onClick={() => setConfigField({ psu: { ...psu, mode: 'preset' } })}
            >
              {preset.label}
            </button>
            <button
              className={isPreset ? '' : 'on'}
              aria-pressed={!isPreset}
              onClick={() => setConfigField({ psu: { ...psu, mode: 'custom' } })}
            >
              Custom
            </button>
          </div>
        </Row>
        {LIMITS.map(({ k, label, unit, custom }) => {
          const bad = !isPreset && parsePsuLimit(typed[k]) === null
          return (
            <Row key={k} k={label} sub={isPreset ? `From the ${preset.label} preset` : custom}>
              <div className="psu-in">
                <input
                  className={`input${isPreset ? ' ro' : ''}${bad ? ' input--bad' : ''}`}
                  style={{ width: 90 }}
                  aria-label={label}
                  aria-invalid={bad}
                  readOnly={isPreset}
                  tabIndex={isPreset ? -1 : undefined}
                  placeholder="—"
                  value={isPreset ? text(preset.limits[k]) : typed[k]}
                  onChange={(e) => onType(k, e.target.value)}
                />
                <span>{unit}</span>
              </div>
            </Row>
          )
        })}
      </div>
      <div className="hint" style={{ margin: '10px 2px 0' }}>
        {isPreset
          ? `${preset.name} — the project’s supply. Display only; no alerts.`
          : 'Enter what the PSU label says, as a positive number. A limit left empty shows plain totals on the Cockpit. Display only; no alerts.'}
      </div>
    </>
  )
}

/**
 * Boards hidden from the Cockpit until they report again (#76; since #93 the only way to tidy
 * the display — Ignore is gone). Un-hide brings one back now; a hidden board also leaves this list
 * on its own when it reports.
 */
function HiddenNodes() {
  const model = useNodeModel()
  const [error, setError] = useState<string>()
  const hidden = model?.hiddenNodes ?? []

  const unhide = async (ids: number[]) => {
    setError(undefined)
    for (const id of ids) {
      const r = await window.skyhawk?.hideNode(id, false)
      if (r && !r.ok) return setError(r.error)
    }
  }

  return (
    <>
      <div className="ig__head">
        <span className="section-h">Hidden boards</span>
        <span className="ig__n">{hidden.length || ''}</span>
        <button
          className="toolbtn"
          style={{ marginLeft: 'auto' }}
          disabled={hidden.length === 0}
          onClick={() => void unhide(hidden.map((n) => n.nodeId))}
        >
          Un-hide all
        </button>
      </div>
      <div className="set-card">
        {hidden.map((n) => {
          const row = hiddenRow(n)
          return (
            <div className="set-row ig" key={n.nodeId}>
              <div className="ig__id">#{n.nodeId}</div>
              <div style={{ flex: 1 }}>
                <div className="set-row__label">{row.label}</div>
                <div className="set-row__desc">{row.desc}</div>
              </div>
              <div>
                <button className="browse" onClick={() => void unhide([n.nodeId])}>
                  Un-hide
                </button>
              </div>
            </div>
          )
        })}
        {hidden.length === 0 && (
          <div className="set-row">
            <div className="set-row__desc">
              No hidden boards. Hide in an offline board’s Cockpit panel lists it here.
            </div>
          </div>
        )}
      </div>
      <div className={error ? 'set-err' : 'hint'} style={{ margin: '10px 2px 0' }}>
        {error ??
          'Hidden = a removed or replaced board, kept off the Cockpit while it’s offline. It comes back by itself when it reports again; Un-hide brings it back now. A board that’s online always shows — it’s active on the bus.'}
      </div>
    </>
  )
}

export function CockpitSection() {
  const model = useNodeModel()
  const attentionBanner = useStore((s) => s.attentionBanner)
  const setConfigField = useStore((s) => s.setConfigField)
  const [resetOpen, setResetOpen] = useState(false)
  const differing = model?.differingCount ?? 0
  const anyAdopted = model?.nodes.some((n) => n.source === 'adopted') ?? false

  return (
    <>
      <SectionHead
        title="Cockpit"
        desc="Global options for the Cockpit tab. A node’s name, console and PDU are set from the node itself (⚙)."
      />
      <div className="set-card">
        <Row k="Reset node mapping" sub={resetRowDesc(differing)}>
          <button
            className="browse"
            disabled={!model || (differing === 0 && !anyAdopted)}
            onClick={() => setResetOpen(true)}
          >
            Reset…
          </button>
        </Row>
        <Row k="Attention banner" sub="Show board-reported problems on the Overview tab">
          <button
            className={`toggle${attentionBanner ? ' on' : ''}`}
            onClick={() => setConfigField({ attentionBanner: !attentionBanner })}
            aria-pressed={attentionBanner}
            aria-label="Attention banner"
          >
            <span />
          </button>
        </Row>
      </div>
      <PowerSupply />
      <HiddenNodes />
      {resetOpen && <ResetDialog model={model} onClose={() => setResetOpen(false)} />}
    </>
  )
}
