// Where the Gateway's status lands in the UI (#94): the title-bar pill, the Device popover and the
// Overview alert (the Cockpit's Attention item comes in main's cockpit snapshot). Presentation only: severity, label, note and
// alert all come from gatewayStatus (main/gateway/gateway-health.ts), computed once in main, and so
// do when it shows (only while the link is up) and where (aboutLink) (R3.4a).
import { versionText } from '@shared/format'
import type { GatewayFirmware, GatewayStatus } from '@shared/gateway'

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
}

/**
 * Nothing before there is anything to say; `device:status` carries none while the link is down
 * (gateway-health shownStatus). `port` goes in the pill's tooltip.
 */
export function gatewayView(g: GatewayStatus | undefined, port?: string): GatewayView {
  if (!g) return {}
  if (g.severity === 'ok') return { health: { text: g.label } }
  const tone = g.severity
  const view: GatewayView = {
    pill: {
      cls: tone === 'err' ? 'devind--err' : 'devind--warn',
      tip: `Gateway reports a problem${port ? ` · ${port}` : ''} — click for details`
    },
    alert: g.alert
  }
  // About the link, not something it reports (main's aboutLink): the popover's title says it.
  if (g.aboutLink) return { ...view, title: g.label, meta: g.note }
  return { ...view, health: { text: g.label, tone, note: g.note } }
}

/**
 * The Gateway's own firmware (#171), worded for the device card's row (`card`) and the popover's
 * (`pop`). Whether it is reported and whether it is newer than this client supports are main's.
 */
export function gatewayFirmwareView(
  f: GatewayFirmware | undefined
): { card: string; pop: string; warn: boolean } | undefined {
  if (!f) return undefined
  if (!f.version) {
    return {
      card: 'not reported · shows after the Gateway’s next restart',
      pop: 'not reported',
      warn: false
    }
  }
  const v = versionText(f.version)
  if (!f.tooNew) return { card: v, pop: v, warn: false }
  return {
    card: `${v} · newer than this client supports (${f.supportedMajor}.x)`,
    pop: `${v} · newer than this client`,
    warn: true
  }
}

/** The client-too-old banner (#171): the Gateway's release and the major this client supports. */
export function clientTooOld(
  f: GatewayFirmware | undefined
): { gateway: string; supported: string } | undefined {
  if (!f?.tooNew || !f.version) return undefined
  return { gateway: versionText(f.version), supported: `${f.supportedMajor}.x` }
}
