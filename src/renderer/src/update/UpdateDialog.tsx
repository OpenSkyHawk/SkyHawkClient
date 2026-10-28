import { useRef } from 'react'
import type { UpdateState } from '@shared/update'
import { useModalFocus } from '../app/kit'
import { useUpdateStore } from './store'
import { updateView } from './update-view'

/**
 * The firmware update dialog (#173; the shared dialog #187 and #175 reuse): confirm, run, failure,
 * result. Main runs the update and pushes each state (`update:state`); this only words it. The
 * app hands in what other topics do: *Stop relay* (dcs) and *Check for updates* (releases).
 */
export function UpdateDialog(props: DialogProps) {
  const s = useUpdateStore((st) => st.update)
  return s && <UpdateBox s={s} {...props} />
}

interface DialogProps {
  onStopRelay: () => void
  onCheckReleases: () => void
  /** A release check is running: *Check for updates* reads *Checking…*. */
  checkingReleases: boolean
}

function UpdateBox({ s, ...props }: DialogProps & { s: UpdateState }) {
  const { ackUpdate, startUpdate, retryUpdate, closeUpdate } = useUpdateStore.getState()
  const ref = useRef<HTMLElement>(null)
  const v = updateView(s)
  // Esc and the scrim close it, except while it runs (main refuses then too).
  useModalFocus(ref, () => {
    if (v.canClose) closeUpdate()
  })

  return (
    <>
      <div className="ad__scrim" onClick={() => v.canClose && closeUpdate()} />
      <section
        ref={ref}
        className="ad ad--up"
        role="dialog"
        aria-modal="true"
        aria-label="Firmware update"
        tabIndex={-1}
      >
        <div className="ad__h">
          <span className={`node__dot ${v.dot}`} aria-hidden="true" />
          <div>
            <div className="ad__t">{v.title}</div>
            <div className="ad__s">{v.sub}</div>
          </div>
          {v.canClose && (
            <button className="toolbtn" style={{ marginLeft: 'auto' }} onClick={closeUpdate}>
              Close
            </button>
          )}
        </div>
        <div className="up__body">
          {s.phase === 'confirm' && (
            <>
              <div className="section-h">Board</div>
              <ul className="evt att up__q" aria-label="Board">
                <li className="fw__li">
                  <span className="node__dot sym" aria-hidden="true">
                    1
                  </span>
                  <span>
                    <b style={{ color: 'var(--text)' }}>{v.board.name}</b>
                    <br />
                    <span style={{ fontSize: 11 }}>{v.board.sub}</span>
                  </span>
                  <span className={`vchip ${v.board.chipCls}`}>{v.board.chip}</span>
                </li>
              </ul>
              <div className="up__chk" aria-label="Checks">
                {v.checks.map((c) => (
                  <div key={c.text}>
                    <i className={c.ok ? 'up__yes' : 'up__no'}>{c.ok ? '✓' : '✕'}</i>
                    <span>{c.text}</span>
                    {c.fix === 'stop-relay' && (
                      <button
                        className="toolbtn"
                        style={{ marginLeft: 'auto' }}
                        onClick={props.onStopRelay}
                      >
                        Stop relay
                      </button>
                    )}
                    {c.fix === 'check-releases' && (
                      <button
                        className="toolbtn"
                        style={{ marginLeft: 'auto' }}
                        disabled={props.checkingReleases}
                        onClick={props.onCheckReleases}
                      >
                        {props.checkingReleases ? 'Checking…' : 'Check for updates'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {v.halves && (
                <>
                  <div className="up__chk up__flags">
                    <div className="up__flag--warn">
                      <i>!</i>
                      <span>
                        <b>Gateway halves differ</b> — {v.halves}
                      </span>
                    </div>
                  </div>
                  <div className="up__ack">
                    <button
                      className={`im__chk${s.ack ? ' on' : ''}`}
                      aria-pressed={s.ack}
                      aria-label="I understand"
                      onClick={() => ackUpdate(!s.ack)}
                    >
                      <span>✓</span>
                    </button>
                    <span>
                      I understand these boards won’t work together until they share a major
                      version.
                    </span>
                  </div>
                </>
              )}
              <div className="up__tips">
                <div>
                  <i>i</i>
                  <span>
                    <b>Gateway</b> — {v.note}
                  </span>
                </div>
              </div>
            </>
          )}
          {s.phase === 'run' && (
            <>
              <div className="up__cur">
                <span className="node__dot on" aria-hidden="true" />
                {s.name}
              </div>
              <div className="up__ph" aria-label="Steps">
                {v.steps.map((p) => (
                  <div key={p.label} className={`up__p ${p.cls}`}>
                    <i>{p.sym}</i>
                    {p.label}
                  </div>
                ))}
              </div>
              <div className="hbar" title={v.pctText} role="img" aria-label={v.pctText}>
                <i style={{ width: `${v.pct}%` }} />
              </div>
            </>
          )}
          {v.fail && (
            <div className="sh__fault sh__fault--err" role="alert">
              <b>{v.fail.title}</b> — {v.fail.text}
            </div>
          )}
          {s.phase === 'done' && (
            <>
              <ul className="evt att up__q" aria-label="Result">
                <li className="fw__li">
                  <span className="node__dot on sym" aria-hidden="true">
                    ✓
                  </span>
                  <span>
                    <b style={{ color: 'var(--text)' }}>{s.name}</b>
                    <br />
                    <span style={{ fontSize: 11 }}>{v.doneSub}</span>
                  </span>
                </li>
              </ul>
              {v.calNote && <div className="hint">{v.calNote}</div>}
              {v.relayHint && <div className="hint">{v.relayHint}</div>}
            </>
          )}
        </div>
        <div className="ad__ft">
          <span className="hint" style={{ margin: 0, flex: 1 }}>
            {v.foot}
          </span>
          {s.phase === 'confirm' && (
            <>
              <button className="toolbtn" onClick={closeUpdate}>
                Cancel
              </button>
              <button className="browse" disabled={!s.canStart} onClick={startUpdate}>
                Update to {s.to}
              </button>
            </>
          )}
          {s.phase === 'fail' && (
            <>
              <button className="toolbtn" onClick={closeUpdate}>
                Close
              </button>
              <button className="browse" onClick={retryUpdate}>
                Retry
              </button>
            </>
          )}
          {s.phase === 'done' && (
            <button className="browse" onClick={closeUpdate}>
              Done
            </button>
          )}
        </div>
      </section>
    </>
  )
}
