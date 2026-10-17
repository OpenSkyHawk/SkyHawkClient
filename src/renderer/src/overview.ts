// Overview (#65): the wording of the new-devices notice. What the tile, the Attention banner and the
// notice say about your cockpit is main's (cockpit:snapshot overview, R3.2b).
import { plural } from '@shared/format'
import type { NewDevices } from '@shared/nodes'

/**
 * `2 new devices on the bus` + what they are. Since #93 a registry board is new too until you add
 * it: `1 panel group from NODE_IDS.md, not added to your cockpit yet.`; unregistered ones are
 * `… not in NODE_IDS.md.`; a mix says how many are from NODE_IDS.md.
 */
export function newDevicesText(d: NewDevices): { head: string; detail: string } {
  const kinds = [
    ...(d.panels ? [plural(d.panels, 'panel group')] : []),
    ...(d.pdus ? [plural(d.pdus, 'PDU')] : [])
  ].join(', ')
  const detail =
    d.registry === 0
      ? `${kinds}, not in NODE_IDS.md.`
      : d.registry === d.count
        ? `${kinds} from NODE_IDS.md, not added to your cockpit yet.`
        : `${kinds}, not added to your cockpit yet — ${d.registry} from NODE_IDS.md.`
  return { head: `${plural(d.count, 'new device')} on the bus`, detail }
}
