// The Firmware button, sheet rows and Overview banner in words (#173), pure: main decides every
// row's status, the count and what can update (`cockpit:snapshot` firmware, overview.firmware);
// this only words them, as the design's `fwInfo` table draws them (CockpitMap.dc.html:837-850).
import type { FirmwareBanner, FirmwareRow, FirmwareSheet, FirmwareStatus } from '@shared/nodes'

/** One row as drawn: its dot, chip and the line beside the chip. */
export interface FirmwareRowView {
  key: string
  /** A board's name carries its NODE_ID; a Gateway side's doesn't. */
  name: string
  /** `node__dot` state class: on / off / warn / new, or none. */
  dot: string
  sym: string
  /** Absent with nothing saved to compare with: the row shows its version only. */
  chip?: string
  chipCls?: string
  sub: string
  /** The board it opens (its panel); a Gateway side opens nothing yet (#177's Gateway sheet). */
  opens?: number
}

const CHIP: Record<Exclude<FirmwareStatus, 'no-release'>, [string, string, string, string]> = {
  off: ['OFFLINE', 'vchip--mute', 'off', '✕'],
  'not-reported': ['NOT REPORTED', 'vchip--mute', '', ''],
  manual: ['MANUAL UPDATE ONLY', 'vchip--warn', 'warn', '!'],
  mismatch: ['MAJOR MISMATCH', 'vchip--warn', 'warn', '!'],
  custom: ['CUSTOM FIRMWARE', 'vchip--mute', '', ''],
  update: ['UPDATE AVAILABLE', 'vchip--upd', 'new', '↑'],
  newer: ['NEWER THAN RELEASE', 'vchip--mute', '', ''],
  ok: ['UP TO DATE', 'vchip--ok', 'on', '']
}

function sub(r: FirmwareRow, target: string | undefined): string {
  const v = r.version ?? ''
  switch (r.status) {
    case 'off':
      return r.version ? `last reported ${v}` : 'no version reported'
    case 'not-reported':
      return r.notReported ? 'version not reported' : ''
    case 'manual':
      return `${v} · no bootloader — update it with a programmer`
    case 'mismatch':
      return `${v} · the Gateway is on ${r.gatewayMajor}.x`
    case 'custom':
      if (r.nodeId === undefined) return `${v} · no image in ${target}`
      return r.kind === 'pdu'
        ? `${v} · no image for #${r.nodeId} in ${target}`
        : `${v} · panel groups install their own build`
    case 'update':
      return `${v} → ${target}`
    case 'newer':
      return `${v} · the release is ${target}`
    case 'ok':
    case 'no-release':
      return v
  }
}

export function firmwareRowView(r: FirmwareRow, target: string | undefined): FirmwareRowView {
  const name = r.nodeId === undefined ? r.name : `${r.name} · #${r.nodeId}`
  const opens = r.nodeId === undefined ? {} : { opens: r.nodeId }
  if (r.status === 'no-release')
    return { key: r.key, name, dot: '', sym: '', sub: sub(r, target), ...opens }
  const [chip, chipCls, dot, sym] = CHIP[r.status]
  return { key: r.key, name, dot, sym, chip, chipCls, sub: sub(r, target), ...opens }
}

const boards = (n: number) => `${n} board${n === 1 ? '' : 's'}`

/** The plan toolbar's *Firmware · n* button: the count, its dot and its tooltip. */
export function firmwareButton(s: FirmwareSheet): { count: number; dot: string; title: string } {
  const n = s.attention
  if (!s.target)
    return { count: n, dot: n ? 'new' : '', title: 'No firmware release saved on this computer' }
  return {
    count: n,
    dot: n ? 'new' : s.allCurrent ? 'on' : '',
    title: n
      ? `${boards(n)} need${n === 1 ? 's' : ''} attention · latest release ${s.target}`
      : s.allCurrent
        ? `Every board runs ${s.target}`
        : `Nothing needs attention · latest release ${s.target}`
  }
}

/** The sheet's line when *Needs attention* lists nothing. */
export const firmwareNone = (s: FirmwareSheet): string =>
  s.allCurrent ? 'Every board runs the latest release.' : 'Nothing needs attention.'

/** The hint under the rows (CM:520). It says the release is saved only while one is. */
export const firmwareHint = (s: FirmwareSheet): string =>
  [
    'Versions as each board reports them.',
    ...(s.target ? ['The latest release is saved on this computer, so updates work offline.'] : []),
    'Panel groups run their own builds; boards without a bootloader need a programmer.'
  ].join(' ')

/** "a", "a and b", "a, b and c". */
function list(parts: string[]): string {
  return parts.length < 2
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

/** The Overview's firmware banner (OV:81): its bold head and the rest. */
export function firmwareBannerText(b: FirmwareBanner): { head: string; detail: string } {
  const can = [
    ...(b.gateway ? ['the Gateway'] : []),
    ...(b.pdus ? [`${b.pdus} PDU${b.pdus === 1 ? '' : 's'}`] : []),
    ...(b.boards ? [boards(b.boards)] : [])
  ]
  const manualVerb = b.manual === 1 ? 'needs' : 'need'
  const detail = can.length
    ? `${list(can)} can update.${b.manual ? ` ${b.manual} more ${b.manual === 1 ? 'board' : 'boards'} ${manualVerb} a manual update.` : ''}`
    : `${boards(b.manual)} ${manualVerb} a manual update.`
  return { head: `Firmware ${b.version} is out`, detail }
}
