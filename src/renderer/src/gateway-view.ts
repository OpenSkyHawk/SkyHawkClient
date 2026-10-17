// Where the Gateway's status lands in the UI (#94): the title-bar pill, the Device popover, the
// Overview alert and the Cockpit's Attention item. Presentation only: severity, label, note and
// alert all come from gatewayStatus (main/gateway/gateway-health.ts), computed once in main.
import type { GatewayStatus } from '@shared/gateway'

export interface GatewayView {
  /** Pill modifier while it reports a problem (replaces `devind--on`); with the "!" symbol. */
  pill?: { cls: 'devind--warn' | 'devind--err'; tip: string }
  /** Popover title and line in place of the link's own: "Not responding" is a link state. */
  title?: string
  meta?: string
  /** The popover's Health row; absent = hidden. */
  health?: { text: string; tone?: 'warn' | 'err'; note?: string }
  /** Serious faults only: the Overview alert. */
  alert?: { head: string; text: string }
  /** Cockpit › Attention: one item while it reports any problem. */
  attention?: { flag: string; state: 'off' | 'warn' }
}

/**
 * Nothing while the link is down: the link state says it all, and the last report would describe
 * a board that may be gone. `port` goes in the pill's tooltip.
 */
export function gatewayView(
  g: GatewayStatus | undefined,
  linkUp: boolean,
  port?: string
): GatewayView {
  if (!linkUp || !g) return {}
  if (g.severity === 'ok') return { health: { text: g.label } }
  const tone = g.severity
  const view: GatewayView = {
    pill: {
      cls: tone === 'err' ? 'devind--err' : 'devind--warn',
      tip: `Gateway reports a problem${port ? ` · ${port}` : ''} — click for details`
    },
    alert: g.alert,
    attention: { flag: g.label, state: tone === 'err' ? 'off' : 'warn' }
  }
  // Not responding is about the link, not something it reports: the popover's title says it.
  if (g.kind === 'not-responding') return { ...view, title: g.label, meta: g.note }
  return { ...view, health: { text: g.label, tone, note: g.note } }
}
