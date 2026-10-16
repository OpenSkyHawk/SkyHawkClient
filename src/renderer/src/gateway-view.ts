// How the Gateway's own health reads in the UI (#94): the title-bar pill, the Device popover's
// Health row, the Overview alert and the Cockpit's Attention item. One table, so they never
// disagree. Only what the Gateway reports (gatewayProblem); the client adds no thresholds.
import {
  GATEWAY_NO_ANSWER_MS,
  gatewayFaultLabel,
  gatewayProblem,
  type GatewayHealth,
  type GatewayRow
} from '@shared/gateway'

/**
 * Client wording for the faults a Gateway reports about itself (NODE_FAULT_CODES). Others show
 * their label alone: the dictionary's descriptions read like firmware notes.
 */
const FAULT_NOTE: Partial<Record<number, string>> = {
  0x05: 'It reports losing its serial link to this computer. If it keeps happening, check the USB cable.',
  0x09: 'Another board on the bus uses NODE_ID 0, the Gateway’s own. Reflash that board with a different NODE_ID.'
}

const SECS = GATEWAY_NO_ANSWER_MS / 1000

export interface GatewayView {
  /** Pill modifier while it reports a problem (replaces `devind--on`); with the "!" symbol. */
  pill?: { cls: 'devind--warn' | 'devind--err'; tip: string }
  /** Popover title and line in place of the link's own: "Not responding" is a link state. */
  title?: string
  meta?: string
  /** The popover's Health row; absent = hidden. */
  health?: { text: string; tone?: 'warn' | 'err'; note?: string }
  /** Serious faults only (panel input can't reach DCS): the Overview alert. */
  alert?: { head: string; text: string }
  /** Cockpit › Attention: one item while it reports any problem. */
  attention?: { flag: string; state: 'off' | 'warn' }
}

const withTemp = (label: string, r: GatewayRow): string =>
  r.dieTempC === null ? label : `${label} · ${r.dieTempC} °C`

/**
 * Nothing while the link is down: the link state says it all, and the last report would describe
 * a board that may be gone. `port` goes in the pill's tooltip.
 */
export function gatewayView(
  h: GatewayHealth | undefined,
  linkUp: boolean,
  port?: string
): GatewayView {
  if (!linkUp || !h) return {}
  const problem = gatewayProblem(h)
  const pill = (cls: 'devind--warn' | 'devind--err') => ({
    cls,
    tip: `Gateway reports a problem${port ? ` · ${port}` : ''} — click for details`
  })
  if (problem?.kind === 'not-responding') {
    return {
      pill: pill('devind--err'),
      title: 'Not responding',
      meta: `No answer for ${SECS} s while the port is open. Unplug its USB cable and plug it back in.`,
      alert: {
        head: 'Gateway not responding',
        text: `no answer for ${SECS} s while its port is open. Unplug its USB cable and plug it back in.`
      },
      attention: { flag: 'Not responding', state: 'off' }
    }
  }
  const r = h.row
  if (!r) return {} // not reported yet (or firmware before v3)
  if (!problem) return { health: { text: withTemp('OK', r) } }
  switch (problem.kind) {
    case 'bus-off':
      return {
        pill: pill('devind--err'),
        health: {
          text: 'Bus-off',
          tone: 'err',
          note: 'It stopped transmitting after too many CAN errors and recovers by itself in about 40 s.'
        },
        alert: {
          head: 'The Gateway can’t reach your panels',
          text: 'its cockpit (CAN) side went bus-off, so panel inputs aren’t reaching DCS. It recovers by itself in about 40 s; if it keeps happening, check the CAN cabling and termination.'
        },
        attention: { flag: 'Bus-off', state: 'off' }
      }
    case 'overheat': {
      const text = withTemp('Overheat', r)
      return {
        pill: pill('devind--warn'),
        health: {
          text,
          tone: 'warn',
          note: 'The Gateway raised its own temperature trip. Check the airflow around it.'
        },
        attention: { flag: text, state: 'warn' }
      }
    }
    case 'error-passive':
      return {
        pill: pill('devind--warn'),
        health: {
          text: 'Error-passive',
          tone: 'warn',
          note: `CAN errors high (TEC ${r.tec}): it still reaches the panels but may drop frames. Check the bus cabling and termination.`
        },
        attention: { flag: 'Error-passive', state: 'warn' }
      }
    default: {
      const text = gatewayFaultLabel(r)
      return {
        pill: pill('devind--warn'),
        health: { text, tone: 'warn', note: FAULT_NOTE[r.faultId] },
        attention: { flag: text, state: 'warn' }
      }
    }
  }
}
