// The Firmware button, sheet rows and Overview banner in words (#173), pure: main decides every
// row's status, the count and what can update (`cockpit:snapshot` firmware, overview.firmware);
// this only words them, as the design's `fwInfo` table draws them (CockpitMap.dc.html:837-850).
import type {
  BoardPanel,
  FirmwareBanner,
  FirmwareRow,
  FirmwareSheet,
  FirmwareStatus
} from '@shared/nodes'

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
  /** Its button (#173: the Gateway's USB side; #187: its cockpit side), as main offers it. */
  update?: true
  /** The button's words: *Retry* when the cockpit side doesn't respond (#187), else *Update*. */
  button?: 'Update' | 'Retry'
  /** What it opens: the row's own update, or the USB side's first (#187). */
  action?: 'update' | 'retry' | 'usb-first'
}

const CHIP: Record<Exclude<FirmwareStatus, 'no-release'>, [string, string, string, string]> = {
  updating: ['UPDATING', 'vchip--upd', 'on', '↻'],
  paused: ['PAUSED', 'vchip--mute', '', ''],
  'not-responding': ['NOT RESPONDING', 'vchip--err', 'off', '✕'],
  'in-drive': ['IN UPDATE DRIVE', 'vchip--warn', 'warn', '!'],
  off: ['OFFLINE', 'vchip--mute', 'off', '✕'],
  'needs-firmware': ['NEEDS FIRMWARE', 'vchip--err', 'off', '✕'],
  'wont-start': ['WON’T START', 'vchip--err', 'off', '✕'],
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
  // The cockpit side's target is the version its USB side carries, when it carries one (#187).
  const to = r.to ?? target
  switch (r.status) {
    case 'updating':
      return `${r.version ?? 'not responding'} → ${to}`
    case 'paused':
      return 'Gateway cockpit side updating'
    case 'not-responding':
      return 'the Gateway answers; its cockpit side doesn’t'
    case 'in-drive':
      return 'waiting in its update drive'
    case 'off':
      return r.version ? `last reported ${v}` : 'no version reported'
    case 'needs-firmware':
      return 'the last update didn’t finish'
    case 'wont-start':
      return 'its firmware kept restarting'
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
      if (r.action === 'usb-first') return `${v} → ${to} · update the USB side first`
      return r.bundled ? `${v} → ${to} · carried by the USB side` : `${v} → ${to}`
    case 'newer':
      return r.bundled ? `${v} · the USB side carries ${to}` : `${v} · the release is ${target}`
    case 'ok':
    case 'no-release':
      return v
  }
}

export function firmwareRowView(r: FirmwareRow, target: string | undefined): FirmwareRowView {
  const name = r.nodeId === undefined ? r.name : `${r.name} · #${r.nodeId}`
  const opens = {
    ...(r.nodeId !== undefined && { opens: r.nodeId }),
    ...(r.action && {
      update: true as const,
      button: r.action === 'retry' ? ('Retry' as const) : ('Update' as const),
      action: r.action
    })
  }
  if (r.status === 'no-release')
    return { key: r.key, name, dot: '', sym: '', sub: sub(r, target), ...opens }
  const [chip, chipCls, dot, sym] = CHIP[r.status]
  return { key: r.key, name, dot, sym, chip, chipCls, sub: sub(r, target), ...opens }
}

/** A board's Status › Firmware section as drawn (CM:340-345): its chip, the boxes and the note. */
export interface BoardFirmwareView {
  installed: string
  /** Absent where the version line says it already (not reported, offline with none). */
  chip?: string
  chipCls?: string
  /** No bootloader: the warning box with *About the bootloader ↗*. */
  noBootloader: boolean
  note?: string
}

/** The note under a board's version (`fwDetail` note), by its sheet row. */
function boardNote(r: FirmwareRow): string | undefined {
  switch (r.status) {
    case 'off':
      return r.version ? 'Offline — it can be updated once it reports again.' : undefined
    case 'mismatch':
      return 'Boards on a different major version than the Gateway don’t work together on the bus.'
    case 'paused':
      return 'Paused while the Gateway’s cockpit side updates.'
    // With no image in the release, the chip alone (#177 adds From file…).
    case 'needs-firmware':
      return r.image ? 'The last update didn’t finish. Update it again.' : undefined
    case 'wont-start':
      return r.image
        ? 'Its firmware kept restarting, so the board stopped running it. Install a different version.'
        : undefined
    default:
      return undefined
  }
}

export function boardFirmwareView(fw: BoardPanel['firmware']): BoardFirmwareView {
  const r = fw.row
  const quiet =
    !r ||
    r.status === 'no-release' ||
    r.status === 'not-reported' ||
    (r.status === 'off' && !r.version)
  const [chip, chipCls] = quiet ? [] : CHIP[r.status as Exclude<FirmwareStatus, 'no-release'>]
  const note = fw.hint ?? (r && boardNote(r))
  return {
    installed: fw.installed,
    ...(chip && { chip, chipCls }),
    noBootloader: r?.status === 'manual',
    ...(note && { note })
  }
}

const boards = (n: number) => `${n} board${n === 1 ? '' : 's'}`

/** Rows that turn the button's dot red (`fwStuck`): nothing runs there until it is fixed. */
const DOWN: ReadonlySet<FirmwareStatus> = new Set([
  'not-responding',
  'needs-firmware',
  'wont-start'
])

/** The plan toolbar's *Firmware · n* button: the count, its dot and its tooltip. */
export function firmwareButton(s: FirmwareSheet): { count: number; dot: string; title: string } {
  const n = s.attention
  const down = s.rows.some((r) => DOWN.has(r.status))
  if (!s.target)
    return {
      count: n,
      dot: down ? 'off' : n ? 'new' : '',
      title: 'No firmware release saved on this computer'
    }
  return {
    count: n,
    dot: down ? 'off' : n ? 'new' : s.allCurrent ? 'on' : '',
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
