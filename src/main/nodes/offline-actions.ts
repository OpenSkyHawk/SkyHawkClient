// Hide and Forget, offline only (pure, no Node/Electron deps): the one rule for when a board may be
// hidden or forgotten, and why not (#93; M1/C3). The Cockpit's footer (cockpit-snapshot/panels.ts
// boardActions) offers them by it, and NodeHub refuses by it, so the two always agree.
//
// Both only tidy the display, and a board that is active on the bus — its controls reach DCS, it
// draws power, it affects bus health — always shows. So both wait until the board is offline by the
// one availability rule (node-model.ts availabilityOf), which already weighs a PDU's pages against
// the roster — the newest evidence wins (X2) — so this reads nothing else: the footer reads the
// model's answer, NodeHub the same rule over the same signals. "unknown" (no complete roster since
// the link opened, the seconds after every reconnect) is not offline.
import type { NodeAvailability } from '@shared/nodes'

export interface OfflineSignals {
  /** The board's availability (node-model.ts availabilityOf), its PDU pages included. */
  availability: NodeAvailability
}

/** Why it can't be hidden or forgotten: it is live, or whether it is on the bus is not known. */
export type OfflineRefusal = 'online' | 'no-roster'

export type OfflineGate = { ok: true } | { ok: false; why: OfflineRefusal; note: string }

/** The footer's line (and each greyed-out button's tip) for a board that is live. */
export const ONLINE_NOTE =
  'Online — it’s active on the bus, so it can’t be removed. Forget and Hide work once it’s offline.'
/** No complete roster yet: whether it is on the bus is not known — not "online" (#93 review). */
export const NO_ROSTER_NOTE =
  'No roster yet — connect the Gateway. Forget and Hide work once the board shows offline.'

function offlineOnly(s: OfflineSignals): OfflineGate {
  if (s.availability === 'online') {
    return { ok: false, why: 'online', note: ONLINE_NOTE }
  }
  if (s.availability === 'unknown') return { ok: false, why: 'no-roster', note: NO_ROSTER_NOTE }
  return { ok: true }
}

/** May it be hidden (until it reports again)? Offline only. */
export function canHide(s: OfflineSignals): OfflineGate {
  return offlineOnly(s)
}

/** May it be forgotten (removed from your cockpit)? Offline only, like Hide. */
export function canForget(s: OfflineSignals): OfflineGate {
  return offlineOnly(s)
}

/** Main's refusal, as the footer shows it under the panel: `what` is "hidden" or "forgotten". */
export function offlineRefusal(why: OfflineRefusal, what: 'hidden' | 'forgotten'): string {
  return why === 'online' ? `It is online — a board on the bus can’t be ${what}` : NO_ROSTER_NOTE
}
