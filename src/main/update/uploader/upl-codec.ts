// The Gateway uploader's UPL_* payloads (#366), pure: encoded and decoded at the offsets
// `npm run sync` reads from UploadProtocol.h. The envelope (magic, SEQ, CRC) is the calibration
// channel's and stays with its owner (hid/calibration CalLink); this is only what rides inside it.
// Multi-byte fields are little-endian.
import {
  CAL_NACK_REASONS,
  CAL_TYPES,
  UPL_BEGIN_FIELD,
  UPL_DATA_FIELD,
  UPL_FLASH_FIELD,
  UPL_INFO_ACK_FIELD as INFO,
  UPL_PHASE,
  UPL_PROTO,
  UPL_RESULT,
  UPL_RESULT_FIELD as RESULT,
  UPL_STATE,
  UPL_STATUS_FIELD as STATUS,
  type CalNackName,
  type CalTypeName,
  type UplPhaseName,
  type UplResultName,
  type UplStateName
} from '@shared/firmware'

/** A generated code-keyed table turned around: name -> code (as hid/calibration's codec does). */
function byName<N extends string>(
  table: Partial<Record<number, { name: N }>>
): Readonly<Record<N, number>> {
  return Object.fromEntries(
    Object.entries(table).map(([code, info]) => [info!.name, Number(code)])
  ) as Record<N, number>
}

/** Calibration-channel message types by name: the UPL_* ones and KEEPALIVE are the uploader's. */
export const UPL_TYPE: Readonly<Record<CalTypeName, number>> = byName(CAL_TYPES)

/** A code -> name lookup of a synced name -> code table; undefined for a code it doesn't list. */
function nameOf<N extends string>(table: Readonly<Record<N, number>>, code: number): N | undefined {
  return (Object.keys(table) as N[]).find((n) => table[n] === code)
}

/** A NACK reason's name, or undefined for one this client's sync doesn't list. */
export const nackReasonName = (reason: number): CalNackName | undefined =>
  CAL_NACK_REASONS[reason]?.name

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8)
const put32 = (b: Uint8Array, at: number, v: number) => {
  for (let i = 0; i < 4; i++) b[at + i] = (v >>> (8 * i)) & 0xff
}
const version = (b: Uint8Array, at: number): string | undefined =>
  b[at] || b[at + 1] || b[at + 2] ? `${b[at]}.${b[at + 1]}.${b[at + 2]}` : undefined

// ── client -> Gateway ────────────────────────────────────────────────────────

/** UPL_BEGIN: the identity block's `imageLength` and `imageCrc`. */
export function encodeBegin(imageLength: number, imageCrc: number): Uint8Array {
  const p = new Uint8Array(UPL_BEGIN_FIELD.CRC + 4)
  put32(p, UPL_BEGIN_FIELD.LENGTH, imageLength)
  put32(p, UPL_BEGIN_FIELD.CRC, imageCrc)
  return p
}

/**
 * UPL_DATA at `offset` (a multiple of the chunk size): the image's bytes from there, up to
 * `imageLength`, 0xFF-padded to a whole chunk.
 */
export function encodeData(image: Uint8Array, imageLength: number, offset: number): Uint8Array {
  const p = new Uint8Array(UPL_DATA_FIELD.BYTES + UPL_PROTO.chunkBytes).fill(0xff)
  put32(p, UPL_DATA_FIELD.OFFSET, offset)
  const end = Math.min(offset + UPL_PROTO.chunkBytes, imageLength)
  p.set(image.subarray(offset, end), UPL_DATA_FIELD.BYTES)
  return p
}

/** UPL_FLASH: the target (a NODE_ID, UPL_TARGET.bridge or .unconfigured) and its new NODE_ID. */
export function encodeFlash(target: number, newNodeId: number): Uint8Array {
  const p = new Uint8Array(UPL_FLASH_FIELD.NEW_NODE_ID + 1)
  p[UPL_FLASH_FIELD.TARGET] = target
  p[UPL_FLASH_FIELD.NEW_NODE_ID] = newNodeId
  return p
}

// ── Gateway -> client ────────────────────────────────────────────────────────

/** What the uploader is doing, and what its last flash did (UPL_INFO_ACK). */
export interface UplInfo {
  proto: number
  /** The largest image it stages. */
  maxImageBytes: number
  chunkBytes: number
  /** undefined: a state this client's sync doesn't list (a newer Gateway). */
  state: UplStateName | undefined
  /** The last flash's target. 0 is also the power-on value: read it with `lastResult`. */
  lastTarget: number
  /** NONE: no flash since the Gateway's USB side powered on (kept in RAM only). */
  lastResult: UplResultName | undefined
  /** The version the last flash confirmed; undefined when none. */
  lastFw?: string
  /** The cockpit-side image bundled in this Gateway firmware (#367); undefined when none. */
  bridgeFw?: string
}

export function decodeInfoAck(p: Uint8Array): UplInfo {
  const lastFw = version(p, INFO.LAST_MAJOR)
  const bridgeFw = version(p, INFO.BRIDGE_MAJOR)
  return {
    proto: p[INFO.PROTO]!,
    maxImageBytes: p[INFO.MAX_IMAGE_KB]! * 1024,
    chunkBytes: u16(p, INFO.CHUNK),
    state: nameOf(UPL_STATE, p[INFO.STATE]!),
    lastTarget: p[INFO.LAST_TARGET]!,
    lastResult: nameOf(UPL_RESULT, p[INFO.LAST_RESULT]!),
    ...(lastFw && { lastFw }),
    ...(bridgeFw && { bridgeFw })
  }
}

/** Where a flash is (UPL_STATUS): sent on each phase, and every 250 ms while writing. */
export interface UplStatus {
  /** undefined: a phase this client's sync doesn't list. */
  phase: UplPhaseName | undefined
  /** The NODE_ID being flashed (the new one after SETTING_ID). */
  target: number
  /** 0 = the first try, then 1..UPL_PROTO.retries. */
  attempt: number
  /** Bootloader blocks acknowledged, of `blocks`. */
  block: number
  blocks: number
}

export function decodeStatus(p: Uint8Array): UplStatus {
  return {
    phase: nameOf(UPL_PHASE, p[STATUS.PHASE]!),
    target: p[STATUS.TARGET]!,
    attempt: p[STATUS.ATTEMPT]!,
    block: u16(p, STATUS.BLOCK),
    blocks: u16(p, STATUS.BLOCKS)
  }
}

/** How a flash ended (UPL_RESULT). */
export interface UplOutcome {
  /** undefined: a result this client's sync doesn't list. */
  result: UplResultName | undefined
  /** The NODE_ID flashed: for an unconfigured board, the one it took. */
  target: number
  /** The version the board reported; undefined when none. */
  fw?: string
  /** Tries used: 1 = the first. */
  attempts: number
  /** From UPL_FLASH to the result. */
  seconds: number
}

export function decodeResult(p: Uint8Array): UplOutcome {
  const fw = version(p, RESULT.MAJOR)
  return {
    result: nameOf(UPL_RESULT, p[RESULT.RESULT]!),
    target: p[RESULT.TARGET]!,
    ...(fw && { fw }),
    attempts: p[RESULT.ATTEMPTS]!,
    seconds: u16(p, RESULT.SECONDS)
  }
}
