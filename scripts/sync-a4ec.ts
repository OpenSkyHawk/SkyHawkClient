/**
 * Firmware sync — regenerates `src/shared/firmware/*.generated.ts` from a PINNED
 * commit of the OpenSkyhawk firmware repo. See PRD.md §7 / §12.
 *
 * Sources (read from the pinned commit):
 *   tools/gen_a4ec/data/A-4E-C.jsonp             -> a4ec-controls.generated.ts
 *   Firmware/Libraries/HIDControls/HIDControls.h -> hid-controls.generated.ts
 *   Firmware/Libraries/SimGateway/SimGateway.cpp -> hid-report-layout.generated.ts (asserted)
 *                                                -> usb-identity.generated.ts
 *   Firmware/Libraries/NodeStatus/NodeStatus.h   -> node-status.generated.ts
 *   Firmware/Libraries/SimGateway/AxisCal.{h,cpp} -> axis-cal.generated.ts
 *   Firmware/Libraries/PanelBridge/PanelBridge.cpp,
 *   Firmware/Libraries/PowerMonitor/TelemSchedule.h -> node-bus.generated.ts
 *   Firmware/NODE_IDS.md                         -> node-names.generated.ts
 *
 * The DCS-BIOS common-metadata address (_ACFT_NAME @ 0x0000) is NOT vendored in
 * the firmware repo, so it lives hand-curated in src/main/dcs/bios-protocol.ts.
 *
 * Source resolution:
 *   1. --local <path> | OPENSKYHAWK_REPO_LOCAL=<path>  read files from a local checkout (no fetch)
 *   2. otherwise sparse-fetch PIN.commit from PIN.repo into a temp dir
 *
 * Output is prettier-formatted in-process so a plain `npm run sync` reproduces
 * the committed bytes exactly — that is what the CI freshness gate diffs.
 * Generated banners carry the source commit (no timestamp, to stay deterministic).
 *
 * @copyright GPL-2.0-only
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { format } from 'prettier'

const PIN = {
  repo: process.env.OPENSKYHAWK_REPO_URL ?? 'https://github.com/OpenSkyhawk/OpenSkyhawk.git',
  commit: 'e82ac6eb7c6ada62135e39a065ddf652eaf35eaf'
}

const SRC = {
  controls: 'tools/gen_a4ec/data/A-4E-C.jsonp',
  hidControls: 'Firmware/Libraries/HIDControls/HIDControls.h',
  nodeStatus: 'Firmware/Libraries/NodeStatus/NodeStatus.h',
  simGateway: 'Firmware/Libraries/SimGateway/SimGateway.cpp',
  axisCal: 'Firmware/Libraries/SimGateway/AxisCal.h',
  axisCalCpp: 'Firmware/Libraries/SimGateway/AxisCal.cpp',
  nodeIds: 'Firmware/NODE_IDS.md',
  panelBridge: 'Firmware/Libraries/PanelBridge/PanelBridge.cpp',
  telemSchedule: 'Firmware/Libraries/PowerMonitor/TelemSchedule.h'
}

const REPO_ROOT = join(__dirname, '..')
const OUT_DIR = join(REPO_ROOT, 'src', 'shared', 'firmware')

const PRETTIER_OPTS = {
  parser: 'typescript' as const,
  semi: false,
  singleQuote: true,
  trailingComma: 'none' as const,
  printWidth: 100,
  tabWidth: 2
}

// ── source resolution ────────────────────────────────────────────────────────

function localRoot(): string | null {
  const idx = process.argv.indexOf('--local')
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1]!
  return process.env.OPENSKYHAWK_REPO_LOCAL ?? null
}

/** Sparse-fetch only the needed files at PIN.commit into a temp dir; returns its path. */
function sparseFetch(paths: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'osh-sync-'))
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] })
  console.log(`[sync] sparse-fetching ${PIN.commit.slice(0, 10)} from ${PIN.repo}`)
  git(['init', '-q'])
  git(['remote', 'add', 'origin', PIN.repo])
  git([
    '-c',
    'protocol.version=2',
    'fetch',
    '-q',
    '--depth',
    '1',
    '--filter=blob:none',
    'origin',
    PIN.commit
  ])
  git(['sparse-checkout', 'init', '--no-cone'])
  git(['sparse-checkout', 'set', '--no-cone', ...paths])
  git(['checkout', '-q', PIN.commit])
  return dir
}

/** Committer date (YYYY-MM-DD) of PIN.commit: the registry's "as of" date, deterministic. */
function commitDate(cwd: string): string {
  return execFileSync('git', ['show', '-s', '--format=%cs', PIN.commit], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  }).trim()
}

type Sources = { [K in keyof typeof SRC]: string } & { commitDate: string; cleanup: () => void }

function loadSources(): Sources {
  const local = localRoot()
  const keys = Object.keys(SRC) as (keyof typeof SRC)[]
  const collect = (read: (p: string) => string) =>
    Object.fromEntries(keys.map((k) => [k, read(SRC[k])])) as Record<keyof typeof SRC, string>

  if (local) {
    console.log(`[sync] reading from local checkout: ${local}`)
    return {
      ...collect((p) => readFileSync(join(local, p), 'utf8')),
      commitDate: commitDate(local),
      cleanup: () => {}
    }
  }
  const dir = sparseFetch(Object.values(SRC))
  return {
    ...collect((p) => readFileSync(join(dir, p), 'utf8')),
    commitDate: commitDate(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const banner = (sources: string[]) =>
  [
    '// AUTO-GENERATED by `npm run sync` (scripts/sync-a4ec.ts) — DO NOT EDIT.',
    `// Source: ${PIN.repo} @ ${PIN.commit}`,
    ...sources.map((s) => `//   ${s}`),
    ''
  ].join('\n')

const hex = (n: number) => '0x' + n.toString(16)
const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/**
 * Parse an `enum [class] Name : type { A = 0x01,  // comment ... }` block into ordered entries.
 * Captures each `NAME = value` plus the trailing `//` comment (the human description).
 *
 * `class` is optional: NodeStatus.h uses scoped enums, AxisCal.h uses plain `enum CalType`.
 * Comments are optional too — AxisCal.h documents the enum rather than each entry, so callers
 * that need labels there derive them from the name via labelize().
 */
function parseEnum(
  header: string,
  enumName: string,
  where: string
): { name: string; value: number; comment: string }[] {
  const block = new RegExp(
    `enum\\s+(?:class\\s+)?${enumName}\\s*:\\s*\\w+\\s*\\{([\\s\\S]*?)\\}`
  ).exec(header)
  if (!block) throw new Error(`[sync] enum ${enumName} not found in ${where}`)
  const entry = /^\s*([A-Z0-9_]+)\s*=\s*(0x[0-9A-Fa-f]+|\d+)\s*,?\s*(?:\/\/\s*(.*?))?\s*$/
  const entries: { name: string; value: number; comment: string }[] = []
  // Column of the last entry's `//`: a comment-only line starting there continues that comment.
  let commentAt = -1
  for (const text of block[1]!.split('\n')) {
    const m = entry.exec(text)
    if (m) {
      entries.push({ name: m[1]!, value: Number(m[2]), comment: (m[3] ?? '').trim() })
      commentAt = m[3] === undefined ? -1 : text.indexOf('//')
      continue
    }
    const more = /^(\s*)\/\/\s*(.*?)\s*$/.exec(text)
    if (more && commentAt >= 0 && more[1]!.length === commentAt) {
      const last = entries[entries.length - 1]!
      last.comment = `${last.comment} ${more[2]}`.trim()
    } else {
      commentAt = -1
    }
  }
  if (entries.length === 0) throw new Error(`[sync] enum ${enumName} had no entries`)
  return entries
}

/**
 * ENUM_NAMEs -> short badge tags: the first underscore token (I2C_PERIPHERAL -> I2C). Names that
 * share a first token get the next token's initial too (OVER_VOLTAGE -> OVER-V, OVER_TEMPERATURE
 * -> OVER-T), so two codes never render the same badge.
 */
function abbrs(names: string[]): Record<string, string> {
  const first = (n: string) => n.split('_')[0]!
  const count = new Map<string, number>()
  for (const n of names) count.set(first(n), (count.get(first(n)) ?? 0) + 1)
  const out: Record<string, string> = {}
  for (const n of names) {
    const [head, next] = n.split('_')
    out[n] = count.get(head!)! > 1 && next ? `${head}-${next[0]}` : head!
  }
  const tags = Object.values(out)
  if (new Set(tags).size !== tags.length) {
    throw new Error(`[sync] NodeFaultCode badge tags collide: ${tags.join(', ')}`)
  }
  return out
}

/** ENUM_NAME -> human label: title-case the first word, lower-case the rest, keep acronyms (I2C). */
const labelize = (name: string): string =>
  name
    .split('_')
    .map((w, i) => {
      if (/\d/.test(w)) return w // keep tokens with digits verbatim (e.g. I2C)
      const lower = w.toLowerCase()
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower
    })
    .join(' ')

/**
 * `[static] constexpr <type> NAME = <value>;` — the scalar form the firmware uses for constants.
 *
 * `<value>` is a literal, or a sum of literals and other constants from the same source
 * (`CAL_MAX_FRAME = CAL_ENVELOPE_BYTES + CAL_MAX_PAYLOAD`), each resolved the same way. Anything
 * else (a cast, a product, a call) is not a value this parser can vouch for, so it fails the sync.
 * The first term may carry a leading `-`, for the signed sentinels
 * (`DIE_TEMP_UNAVAILABLE = -128`); a `-` anywhere else is a subtraction, which still fails.
 */
function constexprNum(src: string, name: string, where: string): number {
  const m = new RegExp(`constexpr\\s+\\w+\\s+${name}\\s*=\\s*([^;]+);`).exec(src)
  if (!m) throw new Error(`[sync] constant ${name} not found in ${where}`)
  return m[1]!.split('+').reduce((sum, raw, i) => {
    let term = raw.trim()
    let sign = 1
    if (i === 0 && term.startsWith('-')) {
      sign = -1
      term = term.slice(1).trim()
    }
    if (/^(0x[0-9A-Fa-f]+|\d+)$/.test(term)) return sum + sign * Number(term)
    if (/^[A-Z_][A-Z0-9_]*$/.test(term)) return sum + sign * constexprNum(src, term, where)
    throw new Error(`[sync] ${name} in ${where}: cannot evaluate '${m[1]!.trim()}'`)
  }, 0)
}

/**
 * A field-offset enum (`NodeStatusField`, `CalCommitField`, …): parseEnum, plus the checks an
 * offset table must pass — strictly ascending (a field runs to the next offset) and inside
 * `bytes`, the length of the row or payload it indexes. A firmware layout the decoders cannot
 * read field-by-field fails the sync here rather than mis-decoding.
 */
function parseOffsets(
  header: string,
  enumName: string,
  where: string,
  bytes: number
): { name: string; value: number; comment: string }[] {
  const es = parseEnum(header, enumName, where)
  es.forEach((e, i) => {
    if (i > 0 && e.value <= es[i - 1]!.value) {
      throw new Error(`[sync] ${enumName}.${e.name} in ${where}: offsets must ascend`)
    }
    if (e.value >= bytes) {
      throw new Error(`[sync] ${enumName}.${e.name} = ${e.value} in ${where}: past ${bytes} bytes`)
    }
  })
  return es
}

/** Offset entries -> `NAME: offset, // firmware comment` lines of a name-keyed object. */
const offsetLines = (es: { name: string; value: number; comment: string }[]): string =>
  es.map((e) => `  ${e.name}: ${e.value},${e.comment ? ` // ${e.comment}` : ''}`).join('\n')

/** Enum entry names -> a TS string-literal union, so name-keyed lookups are typo-checked. */
const nameUnion = (names: string[]): string => names.map(q).join(' | ')

// ── A-4E-C controls ──────────────────────────────────────────────────────────

interface RawOutput {
  address?: number
  mask?: number
  shift_by?: number
  max_value?: number
  max_length?: number
  type?: string
  description?: string
}
interface RawInput {
  interface?: string
  max_value?: number
}
interface RawControl {
  category?: string
  identifier?: string
  outputs?: RawOutput[]
  inputs?: RawInput[]
}

function parseJsonp(text: string): Record<string, Record<string, RawControl>> {
  let t = text
  if (t.trimStart().startsWith('docdata[')) t = t.slice(t.indexOf('\n') + 1)
  t = t.trimEnd().replace(/;\s*$/, '')
  return JSON.parse(t)
}

function genA4ecControls(jsonp: string): string {
  const doc = parseJsonp(jsonp)
  const outputs: { id: string; category: string; o: RawOutput }[] = []
  const inputs: { id: string; category: string; i: RawInput }[] = []

  for (const [category, controls] of Object.entries(doc)) {
    for (const [id, ctrl] of Object.entries(controls)) {
      for (const o of ctrl.outputs ?? []) outputs.push({ id, category, o })
      for (const i of ctrl.inputs ?? []) inputs.push({ id, category, i })
    }
  }

  outputs.sort(
    (a, b) => (a.o.address ?? 0) - (b.o.address ?? 0) || (a.o.shift_by ?? 0) - (b.o.shift_by ?? 0)
  )
  inputs.sort(
    (a, b) => a.id.localeCompare(b.id) || (a.i.interface ?? '').localeCompare(b.i.interface ?? '')
  )

  const outRows = outputs.map(({ id, category, o }) => {
    const max = o.max_value ?? o.max_length ?? 0
    return `  { id: ${q(id)}, category: ${q(category)}, address: ${hex(o.address ?? 0)}, mask: ${hex(
      o.mask ?? 0
    )}, shift: ${o.shift_by ?? 0}, max: ${max}, type: ${q(o.type ?? '')}, description: ${q(
      o.description ?? ''
    )} }`
  })

  const inRows = inputs.map(
    ({ id, category, i }) =>
      `  { id: ${q(id)}, category: ${q(category)}, interface: ${q(i.interface ?? '')}, maxValue: ${
        i.max_value ?? null
      } }`
  )

  return (
    banner([`${SRC.controls} (${outputs.length} outputs, ${inputs.length} inputs)`]) +
    `
export interface A4ecOutput {
  /** DCS-BIOS control identifier, e.g. "ALT_PRESSURE". */
  id: string
  category: string
  /** DCS-BIOS export address. */
  address: number
  /** Bit mask within the 16-bit word at \`address\`. */
  mask: number
  /** Right-shift applied after masking. */
  shift: number
  /** Max raw value (or string length for string outputs). */
  max: number
  /** "integer" | "string" | … */
  type: string
  description: string
}

export interface A4ecInput {
  id: string
  category: string
  /** DCS-BIOS input interface, e.g. "set_state" | "fixed_step" | "action". */
  interface: string
  maxValue: number | null
}

export const A4EC_OUTPUTS: readonly A4ecOutput[] = [
${outRows.join(',\n')}
]

export const A4EC_INPUTS: readonly A4ecInput[] = [
${inRows.join(',\n')}
]

/** Decode-by-address: many controls can share one address via distinct masks. */
export const A4EC_OUTPUTS_BY_ADDRESS: ReadonlyMap<number, readonly A4ecOutput[]> = (() => {
  const m = new Map<number, A4ecOutput[]>()
  for (const o of A4EC_OUTPUTS) {
    const a = m.get(o.address)
    if (a) a.push(o)
    else m.set(o.address, [o])
  }
  return m
})()

/** Command lookup: identifier -> its input interfaces. */
export const A4EC_INPUTS_BY_ID: ReadonlyMap<string, readonly A4ecInput[]> = (() => {
  const m = new Map<string, A4ecInput[]>()
  for (const i of A4EC_INPUTS) {
    const a = m.get(i.id)
    if (a) a.push(i)
    else m.set(i.id, [i])
  }
  return m
})()
`
  )
}

// ── HID controls (CAN controlId space) ───────────────────────────────────────

function titleCase(macroSuffix: string): string {
  return macroSuffix
    .toLowerCase()
    .split('_')
    .map((w) => (w === 'l' || w === 'r' ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

function genHidControls(header: string): string {
  const defRe = /#define\s+(CTRL_\w+)\s+(0x[0-9A-Fa-f]+)\s*(?:\/\/\s*(.*))?$/gm
  const controls: { id: number; macro: string; label: string; comment: string }[] = []
  const sentinels: Record<string, number> = {}
  let m: RegExpExecArray | null
  while ((m = defRe.exec(header))) {
    const macro = m[1]!
    const id = parseInt(m[2]!, 16)
    const comment = (m[3] ?? '').trim()
    if (macro.startsWith('CTRL_ID_')) {
      sentinels[macro] = id
      continue
    }
    controls.push({ id, macro, label: titleCase(macro.replace(/^CTRL_/, '')), comment })
  }
  controls.sort((a, b) => a.id - b.id)

  // Routing ranges from the header's "controlId routing by range" comment block.
  const ranges: Record<string, [number, number]> = {}
  const rangeRe = /0x([0-9A-Fa-f]+)[–-]0x([0-9A-Fa-f]+)\s+HID\s+(axes|hat switches|buttons)/g
  let r: RegExpExecArray | null
  while ((r = rangeRe.exec(header))) {
    const key = r[3] === 'axes' ? 'AXIS' : r[3] === 'buttons' ? 'BUTTON' : 'HAT'
    ranges[key] = [parseInt(r[1]!, 16), parseInt(r[2]!, 16)]
  }

  const rows = controls.map(
    (c) =>
      `  { id: ${hex(c.id)}, macro: ${q(c.macro)}, label: ${q(c.label)}, comment: ${q(c.comment)} }`
  )

  const rangeLines = (['AXIS', 'HAT', 'BUTTON'] as const)
    .filter((k) => ranges[k])
    .map((k) => `  ${k}_MIN: ${hex(ranges[k]![0])},\n  ${k}_MAX: ${hex(ranges[k]![1])}`)
  const sentinelLines = Object.entries(sentinels).map(
    ([k, v]) => `  ${k.replace(/^CTRL_ID_/, '')}: ${hex(v)}`
  )

  return (
    banner([`${SRC.hidControls} (${controls.length} controls)`]) +
    `
export interface HidControl {
  /** CAN controlId (0x0010–0x00FF). NOT a USB-report index. */
  id: number
  macro: string
  label: string
  comment: string
}

export const HID_CONTROLS: readonly HidControl[] = [
${rows.join(',\n')}
]

/** controlId routing ranges + sentinels, mirrored from HIDControls.h. */
export const HID_ID = {
${[...rangeLines, ...sentinelLines].join(',\n')}
} as const

export const HID_CONTROLS_BY_ID: ReadonlyMap<number, HidControl> = new Map(
  HID_CONTROLS.map((c) => [c.id, c])
)
`
  )
}

// ── HID report layout (asserted against firmware struct) ──────────────────────

function genHidReportLayout(cpp: string): string {
  const structRe = /struct\s+__attribute__\(\(packed\)\)\s+HIDReport\s*\{([\s\S]*?)\}/
  const body = structRe.exec(cpp)?.[1]
  if (!body)
    throw new Error('[sync] HIDReport struct not found in SimGateway.cpp — firmware layout changed')

  const fieldRe = /(uint8_t|int16_t)\s+(\w+)\[(\d+)\]/g
  const sizeOf: Record<string, number> = { uint8_t: 1, int16_t: 2 }
  const fields: { name: string; ctype: string; count: number; bytes: number }[] = []
  let f: RegExpExecArray | null
  while ((f = fieldRe.exec(body))) {
    const ctype = f[1]!
    fields.push({ ctype, name: f[2]!, count: Number(f[3]), bytes: sizeOf[ctype]! * Number(f[3]) })
  }

  // Hard assertion: the decoder + UI depend on this exact 34-byte layout.
  const expect = [
    { name: 'buttons', ctype: 'uint8_t', count: 16 },
    { name: 'hats', ctype: 'uint8_t', count: 2 },
    { name: 'axes', ctype: 'int16_t', count: 8 }
  ]
  for (const e of expect) {
    const got = fields.find((x) => x.name === e.name)
    if (!got || got.ctype !== e.ctype || got.count !== e.count) {
      throw new Error(
        `[sync] HIDReport.${e.name} drift: expected ${e.ctype}[${e.count}], got ${
          got ? `${got.ctype}[${got.count}]` : 'missing'
        } — update the firmware-sync expectation and the decoder`
      )
    }
  }

  let offset = 0
  const off: Record<string, number> = {}
  for (const x of fields) {
    off[x.name] = offset
    offset += x.bytes
  }
  if (offset !== 34) throw new Error(`[sync] HIDReport total ${offset}B, expected 34B`)

  // Axis USB usages, in report order, from the descriptor comments.
  const usages = [...cpp.matchAll(/Usage \((X|Y|Z|Rx|Ry|Rz|Slider|Dial)\)/g)].map((u) => u[1]!)

  // Hat logical range, from the descriptor bytes between the Hat Switch usages and their Input
  // item: Logical Minimum (0x15 nn) and Logical Maximum (0x25 nn). Every value in range is a
  // direction, clockwise from N at the minimum; anything above it is the null (centered) state.
  const hatBlock = /0x09,\s*0x39,[\s\S]*?0x81,/.exec(cpp)?.[0]
  if (!hatBlock)
    throw new Error('[sync] hat switch block not found in the SimGateway HID descriptor')
  const hatLogical = (prefix: '0x15' | '0x25', label: string): number => {
    const m = new RegExp(`${prefix},\\s*(0x[0-9A-Fa-f]{2})`).exec(hatBlock)
    if (!m) throw new Error(`[sync] hat ${label} not found in the SimGateway HID descriptor`)
    return Number(m[1])
  }
  const hatMin = hatLogical('0x15', 'Logical Minimum')
  const hatMax = hatLogical('0x25', 'Logical Maximum')
  if (hatMin !== 0) {
    throw new Error(`[sync] hat Logical Minimum is ${hatMin}; the decoder assumes 0 = N`)
  }
  const hatDirections = hatMax - hatMin + 1

  return (
    banner([`${SRC.simGateway} (HIDReport struct + descriptor)`]) +
    `
/**
 * Fixed 34-byte SimGateway HID report. Asserted against the firmware struct at
 * sync time, so a layout change fails \`npm run sync\` loudly.
 *
 * Semantics from the USB HID descriptor (NB: differ from the CAN controlId space):
 *  - axes are SIGNED int16, little-endian, logical range −32768..32767 (no 0x8000 bias).
 *  - hat nibbles encode ${hatMin}..${hatMax} = N/NE/E/SE/S/SW/W/NW; value ≥ ${hatMax + 1} (e.g. 0xF) = null/centered.
 */
export const HID_REPORT_LAYOUT = {
  size: ${offset},
  buttons: { offset: ${off.buttons}, bytes: 16, count: 128 },
  hats: {
    offset: ${off.hats},
    bytes: 2,
    count: 4,
    nibbleBits: 4,
    /** Directions a hat reports: the descriptor's logical range, clockwise from N. */
    directions: ${hatDirections},
    /** Decoded value ≥ this is the centered/null state: above the logical range. */
    centeredAtOrAbove: ${hatMax + 1},
    nullNibble: 0xf
  },
  axes: {
    offset: ${off.axes},
    bytes: 16,
    count: 8,
    signed: true,
    min: -32768,
    max: 32767,
    usages: [${usages.map(q).join(', ')}]
  }
} as const
`
  )
}

// ── node-status contract (reserved DCS-BIOS identifiers, #86) ─────────────────

function genNodeStatus(header: string): string {
  const num = (re: RegExp, label: string): number => {
    const m = re.exec(header)
    if (!m) throw new Error(`[sync] node-status contract missing in NodeStatus.h: ${label}`)
    return Number(m[1])
  }
  const str = (re: RegExp, label: string): string => {
    const m = re.exec(header)
    if (!m) throw new Error(`[sync] node-status contract missing in NodeStatus.h: ${label}`)
    return m[1]!
  }
  const protoVersion = num(/#define\s+NODE_STATUS_PROTO_VERSION\s+(\d+)/, 'PROTO_VERSION')
  const reqAddress = num(/#define\s+NODE_STATUS_REQ_ADDR\s+(0x[0-9A-Fa-f]+)/, 'REQ_ADDR')
  const msgName = str(/#define\s+NODE_STATUS_MSG_NAME\s+"([^"]+)"/, 'MSG_NAME')
  const endMsgName = str(/#define\s+NODE_STATUS_END_MSG_NAME\s+"([^"]+)"/, 'END_MSG_NAME')

  const healthFlags = parseEnum(header, 'NodeHealthFlag', 'NodeStatus.h')
  const faultCodes = parseEnum(header, 'NodeFaultCode', 'NodeStatus.h')
  // HEALTH_n board kind (#344), forwarded as the last _NODE_STATUS field since proto v3.
  const nodeKinds = parseEnum(header, 'NodeKind', 'NodeStatus.h')

  // _NODE_TELEM contract (#216): versioned separately from _NODE_STATUS.
  const telemProto = num(/#define\s+NODE_TELEM_PROTO_VERSION\s+(\d+)/, 'TELEM_PROTO_VERSION')
  const telemMsgName = str(/#define\s+NODE_TELEM_MSG_NAME\s+"([^"]+)"/, 'TELEM_MSG_NAME')
  // INVALID (0x00) is never sent, so it is not a page the client decodes.
  const telemPages = parseEnum(header, 'TelemPage', 'NodeStatus.h').filter((e) => e.value !== 0)
  const railFlags = parseEnum(header, 'PduRailFlag', 'NodeStatus.h')
  const statusFlags = parseEnum(header, 'PduStatusFlag', 'NodeStatus.h')
  const bits = (es: { name: string; value: number }[]) =>
    es.map((e) => `  ${e.name}: ${hex(e.value)}`).join(',\n')
  // bit -> name + the header's trailing comment, verbatim (keys and firmware notes, not UI text).
  const flagInfo = (es: { name: string; value: number; comment: string }[]) =>
    es
      .map((e) => `  ${hex(e.value)}: { name: ${q(e.name)}, description: ${q(e.comment)} }`)
      .join(',\n')

  // Wire layout named by #346: the row offsets, flag bits and sentinels the decoders read.
  const nsNum = (name: string) => constexprNum(header, name, 'NodeStatus.h')
  const statusRowBytes = nsNum('NODE_STATUS_ROW_BYTES')
  const statusFields = parseOffsets(header, 'NodeStatusField', 'NodeStatus.h', statusRowBytes)
  const telemRowBytes = nsNum('NODE_TELEM_ROW_BYTES')
  const telemFields = parseOffsets(header, 'NodeTelemField', 'NodeStatus.h', telemRowBytes)
  const hbFlags = parseEnum(header, 'HeartbeatFlag', 'NodeStatus.h')
  // The TELEM_n frame a PDU page lives in: the _NODE_TELEM row after its FRAME offset (8 bytes).
  const frameAt = telemFields.find((e) => e.name === 'FRAME')?.value
  if (frameAt === undefined)
    throw new Error('[sync] NodeTelemField.FRAME not found in NodeStatus.h')
  const frameBytes = telemRowBytes - frameAt
  const railFields = parseOffsets(header, 'PduRailField', 'NodeStatus.h', frameBytes)
  const pduStatusFields = parseOffsets(header, 'PduStatusField', 'NodeStatus.h', frameBytes)

  const faultAbbr = abbrs(faultCodes.map((e) => e.name))
  const flagEntries = healthFlags.map((e) => `  ${e.name}: ${hex(e.value)}`).join(',\n')
  const faultEntries = faultCodes
    .map(
      (e) =>
        `  ${e.value}: { name: ${q(e.name)}, abbr: ${q(faultAbbr[e.name]!)}, label: ${q(labelize(e.name))}, description: ${q(e.comment)} }`
    )
    .join(',\n')

  return (
    banner([
      `${SRC.nodeStatus} (NODE_STATUS contract v${protoVersion}, NODE_TELEM contract v${telemProto})`
    ]) +
    `
/**
 * Reserved DCS-BIOS identifiers for PanelBridge node-status reporting (#86).
 * The decoder in main/nodes/node-status-wire.ts is written for protoVersion; reference.test.ts
 * asserts this matches SUPPORTED_NODE_PROTO so a firmware bump fails loudly.
 */
export const NODE_STATUS = {
  protoVersion: ${protoVersion},
  reqAddress: ${hex(reqAddress)},
  msgName: ${q(msgName)},
  endMsgName: ${q(endMsgName)}
} as const

/**
 * NODE_ID of the Gateway board's PanelBridge MCU, the CAN master. Its own row leads every
 * _NODE_STATUS roster reply (#344); CAN nodes are 1..MAX_NODE_ID.
 */
export const GATEWAY_NODE_ID = ${nsNum('GATEWAY_NODE_ID')}

/** _NODE_STATUS row length in bytes. Sent as hex, so the argument is twice as many chars. */
export const NODE_STATUS_ROW_BYTES = ${statusRowBytes}

/**
 * _NODE_STATUS row field offsets, in bytes of the decoded row — from NodeStatusField
 * (NodeStatus.h). Hex index = 2 × offset. Each field is fixed-width hex, most-significant byte
 * first; a field runs to the next offset, the last to NODE_STATUS_ROW_BYTES.
 */
export const NODE_STATUS_FIELD = {
${offsetLines(statusFields)}
} as const

/** HB_n \`flags\` bits (the row's HB_FLAGS field) — from HeartbeatFlag (NodeStatus.h). */
export const HEARTBEAT_FLAGS = {
${bits(hbFlags)}
} as const

/** HB_n \`esr\` (the row's ESR field): bit position of the transmit error counter, the low byte. */
export const HB_ESR_TEC_SHIFT = ${nsNum('HB_ESR_TEC_SHIFT')}

/** HB_n \`esr\`: bit position of the receive error counter, the high byte. */
export const HB_ESR_REC_SHIFT = ${nsNum('HB_ESR_REC_SHIFT')}

/**
 * HEALTH_n \`dieTempC\` meaning "unavailable / not yet seen". Signed (int8): the row carries its
 * two's-complement byte.
 */
export const DIE_TEMP_UNAVAILABLE = ${nsNum('DIE_TEMP_UNAVAILABLE')}

/** HEALTH_n \`flags\` bits — from NodeHealthFlag (NodeStatus.h). Decoder masks against these. */
export const NODE_HEALTH_FLAGS = {
${flagEntries}
} as const

/**
 * HEALTH_n \`nodeKind\` (byte 5, the last _NODE_STATUS field) — from NodeKind (NodeStatus.h).
 * Announced by the board's firmware role, never derived from the NODE_ID. Append-only; 0 = unknown.
 */
export const NODE_KINDS = {
${bits(nodeKinds)}
} as const

/** NodeFaultCode entry names: the keys client wording tables look a fault up by. */
export type NodeFaultName = ${nameUnion(faultCodes.map((e) => e.name))}

export interface NodeFaultInfo {
  name: NodeFaultName
  abbr: string
  label: string
  description: string
}

/**
 * HEALTH_n \`faultId\` dictionary — from NodeFaultCode (NodeStatus.h). id -> human label
 * (SkyHawkClient#40 render) + the firmware comment as a description. \`label\` is derived from
 * the enum name; \`description\` is verbatim from the header. Append-only, mirrors the firmware.
 *
 * Partial: parseNodeStatus() passes through ANY wire faultId, incl. reserved/newer codes this
 * build doesn't know — indexing returns \`NodeFaultInfo | undefined\`, so callers must \`?.\` + fall back.
 */
export const NODE_FAULT_CODES: Partial<Record<number, NodeFaultInfo>> = {
${faultEntries}
} as const

/**
 * Reserved DCS-BIOS identifier for PanelBridge node telemetry (#216): one message per TELEM_n
 * frame, forwarded unread. The decoder in main/nodes/node-telem.ts is written for protoVersion;
 * reference.test.ts asserts this matches SUPPORTED_TELEM_PROTO.
 */
export const NODE_TELEM = {
  protoVersion: ${telemProto},
  msgName: ${q(telemMsgName)}
} as const

/** _NODE_TELEM row length in bytes. Sent as hex, so the argument is twice as many chars. */
export const NODE_TELEM_ROW_BYTES = ${telemRowBytes}

/**
 * _NODE_TELEM row field offsets, in bytes of the decoded row — from NodeTelemField (NodeStatus.h).
 * Hex index = 2 × offset. FRAME is the TELEM_n frame unread, in wire order; its byte 0 is the page.
 */
export const NODE_TELEM_FIELD = {
${offsetLines(telemFields)}
} as const

/**
 * PDU_RAIL_12V / PDU_RAIL_5V field offsets, in bytes of the TELEM_n frame — from PduRailField
 * (NodeStatus.h). Little-endian; a field runs to the next offset, the last to the frame's end.
 */
export const PDU_RAIL_FIELD = {
${offsetLines(railFields)}
} as const

/** PDU_STATUS field offsets, in bytes of the TELEM_n frame — from PduStatusField (NodeStatus.h). */
export const PDU_STATUS_FIELD = {
${offsetLines(pduStatusFields)}
} as const

/** PDU_STATUS \`ntcTempDC\` meaning "unavailable": no reading yet, or the NTC is open/shorted. int16. */
export const NTC_TEMP_UNAVAILABLE = ${nsNum('NTC_TEMP_UNAVAILABLE')}

/** TELEM_n page ids — from TelemPage (NodeStatus.h). Global and append-only; 0x00 is invalid. */
export const TELEM_PAGES = {
${bits(telemPages)}
} as const

/** PDU_RAIL_* page byte 1 — from PduRailFlag (NodeStatus.h). All zero = healthy. */
export const PDU_RAIL_FLAGS = {
${bits(railFlags)}
} as const

/** PDU_STATUS page byte 1 — from PduStatusFlag (NodeStatus.h). All zero = healthy, calibrated. */
export const PDU_STATUS_FLAGS = {
${bits(statusFlags)}
} as const

export type PduRailFlagName = keyof typeof PDU_RAIL_FLAGS
export type PduStatusFlagName = keyof typeof PDU_STATUS_FLAGS

export interface PduFlagInfo<N extends string> {
  name: N
  /** The header's comment on the flag, verbatim. A firmware note, not client wording. */
  description: string
}

/**
 * PDU_RAIL_FLAGS bit -> its name and the PduRailFlag comment (NodeStatus.h). The client words its
 * own flag meanings; this is the firmware's side, keyed the same way.
 */
export const PDU_RAIL_FLAG_INFO: Partial<Record<number, PduFlagInfo<PduRailFlagName>>> = {
${flagInfo(railFlags)}
} as const

/** PDU_STATUS_FLAGS bit -> its name and the PduStatusFlag comment (NodeStatus.h). */
export const PDU_STATUS_FLAG_INFO: Partial<Record<number, PduFlagInfo<PduStatusFlagName>>> = {
${flagInfo(statusFlags)}
} as const
`
  )
}

// ── axis-calibration wire contract (OpenSkyhawk#251) ─────────────────────────

/**
 * Payload length per message type, from the `calLenValidForType` switch in AxisCal.cpp.
 *
 * It lives in the .cpp rather than the header, and as a fall-through switch: a run of
 * `case CAL_T_X:` labels terminated by `return len == N;`. Parsed line by line — labels
 * accumulate until a return assigns the length to all of them. The length is a literal or a
 * named AxisCal.h constant (`return len == CAL_DIAG_BYTES;`), resolved like any constexpr; a
 * return the parser can't read fails the sync. `default: return false;`
 * carries no length and is skipped, which is correct: an unknown type is not a frame.
 *
 * Every type must resolve. A type added firmware-side without a length therefore fails the
 * sync rather than silently defaulting, which is the whole point of the LEN-fixed-by-TYPE rule.
 */
function parseLenTable(cpp: string, header: string, typeNames: string[]): Record<string, number> {
  const fn = /bool\s+calLenValidForType\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(cpp)
  if (!fn) throw new Error('[sync] calLenValidForType not found in AxisCal.cpp')

  const out: Record<string, number> = {}
  let pending: string[] = []
  for (const line of fn[1]!.split('\n')) {
    for (const c of line.matchAll(/case\s+(CAL_T_\w+)\s*:/g)) pending.push(c[1]!)
    const r = /return\s+len\b(.*?);/.exec(line)
    if (!r) continue
    const v = /^\s*==\s*(?:(\d+)|([A-Z_][A-Z0-9_]*))\s*$/.exec(r[1]!)
    if (!v) throw new Error(`[sync] calLenValidForType: cannot read '${line.trim()}'`)
    const len = v[1] !== undefined ? Number(v[1]) : constexprNum(header, v[2]!, 'AxisCal.h')
    for (const n of pending) out[n] = len
    pending = []
  }
  if (pending.length) {
    throw new Error(
      `[sync] case labels with no length in calLenValidForType: ${pending.join(', ')}`
    )
  }
  const missing = typeNames.filter((n) => !(n in out))
  if (missing.length) {
    throw new Error(
      `[sync] no payload length for ${missing.join(', ')} — every CalType needs one legal length`
    )
  }
  return out
}

function genAxisCal(header: string, cpp: string, simGateway: string): string {
  const types = parseEnum(header, 'CalType', 'AxisCal.h')
  const nacks = parseEnum(header, 'CalNackReason', 'AxisCal.h')
  const lens = parseLenTable(
    cpp,
    header,
    types.map((t) => t.name)
  )

  const magicM = /constexpr\s+uint8_t\s+CAL_FRAME_MAGIC\s*\[\s*4\s*\]\s*=\s*\{([^}]*)\}/.exec(
    header
  )
  if (!magicM) throw new Error('[sync] CAL_FRAME_MAGIC not found in AxisCal.h')
  const magic = magicM[1]!.split(',').map((b) => Number(b.trim()))
  if (magic.length !== 4 || magic.some((b) => !Number.isInteger(b))) {
    throw new Error(`[sync] CAL_FRAME_MAGIC is not four byte literals: ${magicM[1]}`)
  }

  // Firmware macro -> the name the protocol doc uses. CAL_T_HELLO is the C identifier;
  // HELLO is what 03-uart-usb-hid-protocol.md calls it, and what labelize() can read.
  const short = (n: string) => n.replace(/^CAL_T_/, '').replace(/^CAL_NACK_/, '')

  const typeEntries = types
    .map((t) => {
      const s = short(t.name)
      return `  ${hex(t.value)}: { name: ${q(s)}, macro: ${q(t.name)}, label: ${q(labelize(s))}, fromDevice: ${t.value >= 0x80}, payloadLen: ${lens[t.name]} }`
    })
    .join(',\n')

  const nackEntries = nacks
    .map((n) => {
      const s = short(n.name)
      return `  ${hex(n.value)}: { name: ${q(s)}, macro: ${q(n.name)}, label: ${q(labelize(s))} }`
    })
    .join(',\n')

  const lenEntries = types.map((t) => `  ${hex(t.value)}: ${lens[t.name]}`).join(',\n')

  // Payload field offsets (#346): one enum per type with a payload, entries prefixed by the type
  // (CAL_COMMIT_MIN). Each is bounded by its type's payload length; CAL_DATA's per-axis record by
  // CAL_DATA_REC_BYTES. The prefix is stripped so the generated table reads CAL_COMMIT_FIELD.MIN.
  const dataRecBytes = constexprNum(header, 'CAL_DATA_REC_BYTES', 'AxisCal.h')
  const fieldTables = [
    ['CalHelloAckField', 'CAL_HELLO_ACK', lens.CAL_T_HELLO_ACK],
    ['CalDataField', 'CAL_DATA', lens.CAL_T_CAL_DATA],
    ['CalDataRecField', 'CAL_DATA_REC', dataRecBytes],
    ['CalSessionOpenField', 'CAL_SESSION_OPEN', lens.CAL_T_SESSION_OPEN],
    ['CalSessionAckField', 'CAL_SESSION_ACK', lens.CAL_T_SESSION_ACK],
    ['CalStreamSelectField', 'CAL_STREAM_SELECT', lens.CAL_T_STREAM_SELECT],
    ['CalCommitField', 'CAL_COMMIT', lens.CAL_T_COMMIT],
    ['CalResetField', 'CAL_RESET', lens.CAL_T_RESET],
    ['CalAckField', 'CAL_ACK', lens.CAL_T_ACK],
    ['CalNackField', 'CAL_NACK', lens.CAL_T_NACK],
    ['CalRawField', 'CAL_RAW', lens.CAL_T_RAW],
    ['CalDiagField', 'CAL_DIAG', lens.CAL_T_DIAG]
  ] as const
  const fieldConsts = fieldTables
    .map(([enumName, prefix, bytes]) => {
      if (bytes === undefined) throw new Error(`[sync] no payload length bounds ${enumName}`)
      const es = parseOffsets(header, enumName, 'AxisCal.h', bytes).map((e) => {
        if (!e.name.startsWith(`${prefix}_`)) {
          throw new Error(
            `[sync] ${enumName}.${e.name} in AxisCal.h: expected the ${prefix}_ prefix`
          )
        }
        return { ...e, name: e.name.slice(prefix.length + 1) }
      })
      const into = enumName === 'CalDataRecField' ? 'one CAL_DATA record' : 'the payload'
      return `/** ${enumName} (AxisCal.h): byte offsets into ${into}, ${bytes} byte${bytes === 1 ? '' : 's'}. */
export const ${prefix}_FIELD = {
${offsetLines(es)}
} as const`
    })
    .join('\n\n')

  // DIAG (#355): the length table already resolved CAL_T_DIAG to CAL_DIAG_BYTES; cross-check it so
  // the exported constant and the frame table can never disagree.
  const diagBytes = constexprNum(header, 'CAL_DIAG_BYTES', 'AxisCal.h')
  if (lens.CAL_T_DIAG !== diagBytes) {
    throw new Error(`[sync] CAL_T_DIAG length ${lens.CAL_T_DIAG} != CAL_DIAG_BYTES ${diagBytes}`)
  }
  const resetReasons = parseEnum(header, 'CalDiagResetReason', 'AxisCal.h').map((e) => {
    if (!e.name.startsWith('CAL_DIAG_RESET_')) {
      throw new Error(`[sync] CalDiagResetReason.${e.name}: expected the CAL_DIAG_RESET_ prefix`)
    }
    return { ...e, name: e.name.slice('CAL_DIAG_RESET_'.length) }
  })

  return (
    banner([
      `${SRC.axisCal} (calibration wire contract)`,
      `${SRC.axisCalCpp} (payload length table)`,
      `${SRC.simGateway} (calibration session timeout)`
    ]) +
    `
/**
 * SimGateway axis-calibration protocol constants. Wire contract:
 * FirmwarePlan/03-uart-usb-hid-protocol.md § Calibration Protocol (USB CDC).
 *
 * The codec in main/hid/calibration/codec.ts imports these through the shared/firmware barrel
 * rather than restating them; reference.test.ts pins the values the codec is written for, so a
 * firmware bump fails loudly.
 */
export const CAL_PROTO = {
  /** Protocol version. HELLO_ACK carries this; gate on it, not on the firmware version. */
  version: ${constexprNum(header, 'CAL_PROTO_VERSION', 'AxisCal.h')},
  /** Stored-blob layout version, reported by HELLO_ACK as \`blobVersion\`. */
  blobVersion: ${constexprNum(header, 'CAL_VERSION', 'AxisCal.h')},
  /** HID report axis slots. Fixed by the descriptor, not by how many a cockpit populates. */
  axisSlots: ${constexprNum(header, 'AXIS_CAL_SLOTS', 'AxisCal.h')},
  /** Axis-selection sentinel: "all" for RESET, "none" for SESSION_OPEN / STREAM_SELECT. */
  axisNone: ${hex(constexprNum(header, 'CAL_AXIS_NONE', 'AxisCal.h'))},
  /** magic 4 + type 1 + seq 1 + len 2 + crc 2. */
  envelopeBytes: ${constexprNum(header, 'CAL_ENVELOPE_BYTES', 'AxisCal.h')},
  /** CAL_DATA, the largest legal payload — the bound on how much a receiver may buffer. */
  maxPayload: ${constexprNum(header, 'CAL_MAX_PAYLOAD', 'AxisCal.h')},
  /** Envelope + the largest payload: the largest complete frame, and so a receiver's carry bound. */
  maxFrame: ${constexprNum(header, 'CAL_MAX_FRAME', 'AxisCal.h')},
  /** The gateway closes a calibration session idle this long. SESSION_ACK reports it too. */
  sessionTimeoutMs: ${constexprNum(simGateway, 'CAL_SESSION_TIMEOUT_MS', 'SimGateway.cpp')},
  /** One CAL_DATA per-axis record, in bytes. Record i starts at CAL_DATA_FIELD.RECORDS + i × this. */
  dataRecBytes: ${dataRecBytes},
  /** Frame lead-in "\\xAA S K C". Not collision-proof outbound, which is why the CRC is mandatory. */
  magic: [${magic.map(hex).join(', ')}]
} as const

/** Message type names, as the protocol doc writes them. */
export type CalTypeName = ${nameUnion(types.map((t) => short(t.name)))}

/** NACK reason names, as the protocol doc writes them. */
export type CalNackName = ${nameUnion(nacks.map((n) => short(n.name)))}

export interface CalTypeInfo {
  /** Name as the protocol doc writes it, e.g. \`SESSION_OPEN\`. */
  name: CalTypeName
  /** The firmware identifier it came from, e.g. \`CAL_T_SESSION_OPEN\`. */
  macro: string
  label: string
  /** High bit of the type byte set = device -> client. */
  fromDevice: boolean
  /** The single legal payload length for this type. */
  payloadLen: number
}

/** Message types, keyed by wire type byte — from CalType (AxisCal.h). */
export const CAL_TYPES: Partial<Record<number, CalTypeInfo>> = {
${typeEntries}
} as const

export interface CalNackInfo {
  name: CalNackName
  macro: string
  label: string
}

/**
 * NACK reasons, keyed by wire reason byte — from CalNackReason (AxisCal.h).
 *
 * Partial: three of these cannot reach a client. BAD_CRC and BAD_LENGTH are rejected at the
 * framing layer, where a failing candidate is not a frame at all and its bytes are relayed
 * instead of answered; BAD_TYPE likewise, so the gateway's \`default:\` arm is unreachable from
 * the wire. A protocol mismatch therefore surfaces as a timeout on HELLO, never as a NACK.
 */
export const CAL_NACK_REASONS: Partial<Record<number, CalNackInfo>> = {
${nackEntries}
} as const

/**
 * type byte -> its one legal payload length.
 *
 * Checked BEFORE the payload is buffered. LEN is read before the CRC can be verified, so on a
 * false frame it is noise — a stray magic in DCS-BIOS text can decode a LEN near 65535, and a
 * receiver that waits for that many bytes stalls its line assembly.
 */
export const CAL_PAYLOAD_LEN: Partial<Record<number, number>> = {
${lenEntries}
} as const

// Payload field offsets — byte offsets into a type's payload (not the frame). Multi-byte fields
// are little-endian; a field runs to the next offset, the last to the type's payload length.

${fieldConsts}

/** DIAG payload length (CAL_DIAG_BYTES). From CAL_DIAG_FIELD.RESERVED on: sent as 0, ignored on receive. */
export const CAL_DIAG_BYTES = ${diagBytes}

/** DIAG RESET_REASON values — from CalDiagResetReason (AxisCal.h). Append-only: a newer value is unknown, not an error. */
export const CAL_DIAG_RESET_REASONS = {
${offsetLines(resetReasons)}
} as const
`
  )
}

// ── NODE_ID -> panel name registry ───────────────────────────────────────────

function genNodeNames(md: string, date: string): string {
  const rows: { id: number; name: string; console: string }[] = []
  // table rows: | NODE_ID | Panel Group | Console | Status |
  const re = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(md))) {
    rows.push({ id: Number(m[1]), name: m[2]!.trim(), console: m[3]!.trim() })
  }
  if (rows.length === 0) throw new Error('[sync] no NODE_ID rows found in NODE_IDS.md')
  rows.sort((a, b) => a.id - b.id)
  const entries = rows.map((r) => `  ${r.id}: { name: ${q(r.name)}, console: ${q(r.console)} }`)

  return (
    banner([`${SRC.nodeIds} (${rows.length} entries)`]) +
    `
/** CAN NODE_ID -> panel group name, from the firmware NODE_IDS.md registry. */
export const NODE_NAMES: Record<number, { name: string; console: string }> = {
${entries.join(',\n')}
}

/** Where NODE_NAMES came from, shown in Settings › About. \`date\` is the commit's date. */
export const NODE_REGISTRY_SOURCE = {
  file: ${q(SRC.nodeIds)},
  commit: ${q(PIN.commit)},
  date: ${q(date)}
}
`
  )
}

// ── CAN node bus (PanelBridge roster, PDU telemetry schedule) ────────────────

function genNodeBus(panelBridge: string, telemSchedule: string): string {
  return (
    banner([`${SRC.panelBridge} (MAX_NODE_ID)`, `${SRC.telemSchedule} (TELEM_PERIOD_MS)`]) +
    `
/** Highest CAN NODE_ID PanelBridge tracks. Panel nodes are 1..MAX_NODE_ID. */
export const MAX_NODE_ID = ${constexprNum(panelBridge, 'MAX_NODE_ID', 'PanelBridge.cpp')}

/**
 * A PDU sends one TELEM_n frame per period, rotating through its pages, so each page refreshes
 * every (page count × period). How long the client waits before calling a page stale is its own
 * policy, not this.
 */
export const TELEM_PERIOD_MS = ${constexprNum(telemSchedule, 'TELEM_PERIOD_MS', 'TelemSchedule.h')}
`
  )
}

// ── SimGateway USB identity ──────────────────────────────────────────────────

function genUsbIdentity(cpp: string): string {
  /** The single match of `re` in SimGateway.cpp; zero or several fails the sync. */
  const only = (re: RegExp, label: string): RegExpMatchArray => {
    const all = [...cpp.matchAll(re)]
    if (all.length !== 1) {
      throw new Error(`[sync] USB ${label}: expected one in SimGateway.cpp, found ${all.length}`)
    }
    return all[0]!
  }
  const id = only(
    /TinyUSBDevice\.setID\(\s*(0x[0-9A-Fa-f]+)\s*,\s*(0x[0-9A-Fa-f]+)\s*\)/g,
    'setID(vid, pid)'
  )
  const str = (re: RegExp, label: string) => only(re, label)[1]!
  const manufacturer = str(
    /TinyUSBDevice\.setManufacturerDescriptor\(\s*"([^"]*)"\s*\)/g,
    'manufacturer descriptor'
  )
  const product = str(
    /TinyUSBDevice\.setProductDescriptor\(\s*"([^"]*)"\s*\)/g,
    'product descriptor'
  )
  const cdcInterface = str(
    /\bSerial\.setStringDescriptor\(\s*"([^"]*)"\s*\)/g,
    'CDC interface name'
  )
  const baud = Number(only(/\bSerial\.begin\(\s*(\d+)\s*\)/g, 'CDC Serial.begin(baud)')[1])

  return (
    banner([`${SRC.simGateway} (SimGateway::setup USB identity)`]) +
    `
/**
 * How the SimGateway enumerates over USB, as SimGateway::setup() sets it before TinyUSB starts.
 * The client finds the Gateway's serial port by vid/pid.
 */
export const USB_IDENTITY = {
  vid: ${hex(Number(id[1]))},
  pid: ${hex(Number(id[2]))},
  manufacturer: ${q(manufacturer)},
  product: ${q(product)},
  /** The CDC interface name (iInterface), so the serial port is identifiable by name. */
  cdcInterface: ${q(cdcInterface)},
  /** Nominal CDC baud. USB CDC ignores it, but opening a serial port needs a value. */
  baud: ${baud}
} as const
`
  )
}

// ── main ─────────────────────────────────────────────────────────────────────

async function writeGenerated(file: string, code: string): Promise<void> {
  const formatted = await format(code, PRETTIER_OPTS)
  writeFileSync(join(OUT_DIR, file), formatted)
  console.log(`[sync] wrote src/shared/firmware/${file}`)
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true })
  const s = loadSources()
  try {
    await writeGenerated('a4ec-controls.generated.ts', genA4ecControls(s.controls))
    await writeGenerated('hid-controls.generated.ts', genHidControls(s.hidControls))
    await writeGenerated('hid-report-layout.generated.ts', genHidReportLayout(s.simGateway))
    await writeGenerated('node-status.generated.ts', genNodeStatus(s.nodeStatus))
    await writeGenerated('node-names.generated.ts', genNodeNames(s.nodeIds, s.commitDate))
    await writeGenerated('axis-cal.generated.ts', genAxisCal(s.axisCal, s.axisCalCpp, s.simGateway))
    await writeGenerated('node-bus.generated.ts', genNodeBus(s.panelBridge, s.telemSchedule))
    await writeGenerated('usb-identity.generated.ts', genUsbIdentity(s.simGateway))
  } finally {
    s.cleanup()
  }
  console.log('[sync] done.')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
