import { STATE_SYMBOL, type NodeState } from '../../cockpit'

/** Status dot with its symbol — never colour alone. */
export function Dot({ state }: { state: NodeState }) {
  const sym = STATE_SYMBOL[state]
  return (
    <span className={`node__dot ${state}${sym ? ' sym' : ''}`} aria-hidden="true">
      {sym}
    </span>
  )
}
