// Cockpit side panels presentation (R3.2): the "updated N s ago" clock, the Power zone lists the
// forms read from the pushed snapshot, and the patch Save sends from the unsaved placement form.
// What a board offers and says is main's (cockpit:snapshot panels).
import type { MappingPatch, NodeModelEntry, ZoneChoices } from '@shared/nodes'

/**
 * How fresh "Reported by the node" is: the bridge resends the roster every 5 s, so the values
 * change in steps — this ticks between them instead of inventing values. "updated 3 s ago" while it
 * reports; "last report 2 min ago" once it stopped; nothing when this session never heard from it.
 */
export function reportAge(e: NodeModelEntry, now: number): string {
  if (e.reportedAt === undefined) return ''
  const s = Math.max(0, Math.floor((now - e.reportedAt) / 1000))
  const ago = s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ago`
  return e.availability === 'online' ? `updated ${ago}` : `last report ${ago}`
}

/**
 * The Power zone list main pushed for a panel on `console` whose zone is `current`: only PDUs in
 * your cockpit, a hidden one labelled so (D7). Changing the console clears the zone (N9).
 */
export function zoneOptions(
  zones: ZoneChoices,
  console: string,
  current: number | null
): { value: number; label: string }[] {
  const byZone = zones.options[console]
  return (current === null ? undefined : byZone?.[current]) ?? byZone?.[''] ?? []
}

export interface PlacementForm {
  name: string
  console: string
  pduId: number | null
}

/** Only what changed, so Save writes nothing when nothing did. A PDU has no power zone. */
export function mappingPatch(e: NodeModelEntry, f: PlacementForm): MappingPatch {
  const p: MappingPatch = {}
  if (f.name.trim() !== e.name) p.name = f.name.trim()
  if (f.console !== (e.console ?? '')) p.console = f.console
  if (e.kind === 'panel' && f.pduId !== e.pduId) p.pduId = f.pduId
  return p
}
