// The relay's surfaces in words (R3.4b: the relay half of the old device view): the pill's tooltip,
// the note under Start, why Start is blocked. What each says is main's (relay:facts, relay-rules).
import type {
  EndpointLabel,
  RelayFacts,
  RelaySurfaces,
  RelayTip,
  RelayWaiting,
  StreamState
} from '@shared/dcs'

/** The relay's surfaces for the on/off as shown — the pending Start or Stop included (R3.3). */
export function relaySide(f: RelayFacts, relaying: boolean): RelaySurfaces {
  return relaying ? f.running : f.stopped
}

/** An endpoint as a surface labels it: main's choice, filled in with the host and port typed. */
export function endpointText(label: EndpointLabel, host: string, port: string): string {
  return 'text' in label ? label.text : `${host}:${port}${label.hostPort.suffix}`
}

/**
 * Tooltip on the relay pill: where the DCS-BIOS stream stands, for the branch main picked
 * (relay-rules relayTip). A relay keeps running through a drop, so while it is waiting the
 * tooltip says what for, rather than looking broken.
 */
export function relayTip(opts: {
  tip: RelayTip
  stream?: StreamState
  deviceLabel: string
  endpoint: string
  replayFile?: string
}): string {
  switch (opts.tip) {
    case 'replay-stopped':
      return 'Replay stopped — click to play'
    case 'replay-ended':
      return 'Replay · ended — click to stop'
    case 'replay-playing': {
      const file = opts.replayFile?.split(/[/\\]/).pop()
      return `Replay · playing${file ? ` ${file}` : ''} — click to stop`
    }
    case 'stopped':
      return 'DCS-BIOS stream stopped — click to start'
    case 'waiting-device':
      return `Relaying — waiting for the Gateway (device link ${opts.deviceLabel.toLowerCase()}). Resumes when it connects — click to stop`
    case 'waiting-dcs':
      return `Relaying — waiting for DCS-BIOS (${opts.stream ?? 'connecting'}) · ${opts.endpoint} — click to stop`
    case 'delivering':
      return `DCS-BIOS stream · connected · ${opts.endpoint} — click to stop`
  }
}

/**
 * The line under the Connection tab's Start / Stop button: what a running relay is waiting for,
 * as main judged it (relay-rules relayNote).
 */
export function relayNote(
  waiting: RelayWaiting,
  stream?: StreamState
): { text: string; info: boolean } | undefined {
  if (waiting === 'device') {
    return { text: 'Relaying — waiting for the Gateway. Resumes when it connects.', info: false }
  }
  if (waiting === 'dcs') {
    return {
      text: `Relaying — waiting for DCS-BIOS (${stream ?? 'connecting'}).`,
      info: false
    }
  }
  if (waiting === 'replay-ended') {
    return { text: 'Replay ended — Stop, or load another capture.', info: false }
  }
  return undefined
}

/**
 * Why Start is unavailable, for the pill tooltip and the note under the Start button: by the
 * mode main says needs the board (relay-rules startBlocked).
 */
export function startBlockedReason(reason: 'bridge' | 'replay'): string {
  return reason === 'replay'
    ? 'Connect the Gateway to play the capture to it, or turn Drive Gateway off.'
    : 'Connect the Gateway to start the relay.'
}

/** Body of the callout a blocked Relay pill answers a click with. */
export function startBlockedCallout(reason: 'bridge' | 'replay'): string {
  return reason === 'replay'
    ? "The Gateway isn't connected, and Drive Gateway plays the capture to it. Connect first, or turn Drive off."
    : "The Gateway isn't connected, and the relay delivers to it. Connect first."
}
