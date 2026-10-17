import type { HidFreshness } from '@shared/hid'

/**
 * How recently the device last said anything, as a colour: the band main pushes on `hid:report`,
 * or "no link" while `device:status` says the board is absent (R3.3: both decided in main —
 * main/hid/hid-facts.ts and main/gateway/link-state.ts). Red is reserved for that one case: the
 * board is not there, so nothing could arrive.
 */
const BAND = {
  live: { cls: 'rate--live', label: 'live' },
  idle: { cls: 'rate--idle', label: 'idle' },
  quiet: { cls: 'rate--stale', label: 'quiet' }
} as const

export function freshnessView(boardPresent: boolean, band: HidFreshness) {
  if (!boardPresent) return { cls: 'rate--down', label: 'no link' }
  return BAND[band]
}
