// A board image's identity block (#362), pure: what the image says it is for, read before it is
// staged on the Gateway (#187; #175 and #177 reuse it). The block sits at a fixed offset from the
// app's start and is stamped after linking with the image's length and CRC. A newer layout may grow
// the block, so this reads the prefix it knows (FirmwareImage.h).
//
// The layout and the CRC's test vectors come from `npm run sync` (firmware-image.generated.ts). The
// CRC is CRC-32/MPEG-2 over little-endian 32-bit words, the `imageCrc` word itself skipped: what the
// Gateway's uploader recomputes before it flashes (Uploader.cpp imageCrc).
import { FIRMWARE_IMAGE, FIRMWARE_IMAGE_FIELD as F, UPL_PROTO } from '@shared/firmware'

/** What an image's identity block says. Versions are `x.y.z` text. */
export interface ImageIdentity {
  layoutVersion: number
  /** The block's own size: at least what this client reads, more on a newer layout. */
  blockSize: number
  /** Bytes from the app's start, padded to 4: what is staged and flashed. */
  imageLength: number
  imageCrc: number
  nodeId: number
  /** NodeKind of the image's role (NODE_KINDS). */
  nodeKind: number
  version: string
}

/**
 * Why an image can't be read as one:
 * - `too-short`: the file ends before the identity block does;
 * - `no-magic`: no identity block (not an OpenSkyhawk app image, or not a `.bin`);
 * - `layout`: a layout this client can't read (version 0, or a block too short for its fields);
 * - `unstamped`: the build never stamped its length and CRC;
 * - `length`: the stamped length isn't a whole number of words, is past the uploader's limit, is
 *   past the end of the file, or ends inside the block.
 */
export type IdentityRefusal = 'too-short' | 'no-magic' | 'layout' | 'unstamped' | 'length'

export type IdentityResult = { ok: true; id: ImageIdentity } | { ok: false; why: IdentityRefusal }

/** The bytes this client reads from the block: up to and including the version's patch. */
const KNOWN_PREFIX = F.FW_PATCH + 1

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8)
const u32 = (b: Uint8Array, at: number) =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0

/** Read the identity block of `bytes`, an app image from its first byte. */
export function parseIdentity(bytes: Uint8Array): IdentityResult {
  const at = FIRMWARE_IMAGE.identityOffset
  if (bytes.length < at + KNOWN_PREFIX) return { ok: false, why: 'too-short' }
  if (u32(bytes, at + F.MAGIC) !== FIRMWARE_IMAGE.magic) return { ok: false, why: 'no-magic' }
  const layoutVersion = u16(bytes, at + F.LAYOUT)
  const blockSize = u16(bytes, at + F.SIZE)
  if (layoutVersion < 1 || blockSize < KNOWN_PREFIX) return { ok: false, why: 'layout' }
  const imageLength = u32(bytes, at + F.LENGTH)
  const imageCrc = u32(bytes, at + F.CRC)
  if (imageLength === FIRMWARE_IMAGE.unstamped || imageCrc === FIRMWARE_IMAGE.unstamped) {
    return { ok: false, why: 'unstamped' }
  }
  if (
    imageLength % 4 !== 0 ||
    imageLength > UPL_PROTO.maxImageBytes ||
    imageLength > bytes.length ||
    imageLength < at + blockSize
  ) {
    return { ok: false, why: 'length' }
  }
  return {
    ok: true,
    id: {
      layoutVersion,
      blockSize,
      imageLength,
      imageCrc,
      nodeId: bytes[at + F.NODE_ID]!,
      nodeKind: bytes[at + F.NODE_KIND]!,
      version: `${bytes[at + F.FW_MAJOR]}.${bytes[at + F.FW_MINOR]}.${bytes[at + F.FW_PATCH]}`
    }
  }
}

/**
 * CRC-32/MPEG-2 (poly 0x04C11DB7, init 0xFFFFFFFF, no reflection, no final XOR) over the first
 * `length` bytes of `bytes` read as little-endian 32-bit words — what the STM32F1's CRC unit
 * computes. `skipAt`: the byte offset of one word left out (the image's own `imageCrc`).
 * `length` must be a multiple of 4.
 */
export function crc32Words(bytes: Uint8Array, length: number, skipAt?: number): number {
  let crc = 0xffffffff
  for (let i = 0; i < length; i += 4) {
    if (i === skipAt) continue
    crc = (crc ^ u32(bytes, i)) >>> 0
    for (let b = 0; b < 32; b++) {
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0
    }
  }
  return crc
}

/** An image's CRC as its identity block stamps it: over `imageLength`, the CRC word skipped. */
export const imageCrc32 = (bytes: Uint8Array, imageLength: number): number =>
  crc32Words(bytes, imageLength, FIRMWARE_IMAGE.identityOffset + F.CRC)

/** What the image must be for: the board it goes to and, when known, the version expected. */
export interface ImageWant {
  nodeId: number
  nodeKind: number
  version?: string
}

/**
 * Why an image isn't the one to send: unreadable (`IdentityRefusal`), its contents don't match its
 * stamped CRC (`damaged`), it was built for another board (`wrong-board`: NODE_ID or kind), or it
 * isn't the version expected (`wrong-version`).
 */
export type ImageRefusal = IdentityRefusal | 'damaged' | 'wrong-board' | 'wrong-version'

export type ImageCheck = { ok: true; id: ImageIdentity } | { ok: false; why: ImageRefusal }

/**
 * Check an image before it is staged: readable, intact, and built for `want`. The kind is compared
 * with the constant the caller passes (e.g. NODE_KINDS.BRIDGE), never with a board's live row: a
 * board that isn't responding has no row, and a freshly booted one reads UNKNOWN.
 */
export function checkImageFor(bytes: Uint8Array, want: ImageWant): ImageCheck {
  const r = parseIdentity(bytes)
  if (!r.ok) return r
  const { id } = r
  if (imageCrc32(bytes, id.imageLength) !== id.imageCrc) return { ok: false, why: 'damaged' }
  if (id.nodeId !== want.nodeId || id.nodeKind !== want.nodeKind) {
    return { ok: false, why: 'wrong-board' }
  }
  if (want.version !== undefined && id.version !== want.version) {
    return { ok: false, why: 'wrong-version' }
  }
  return { ok: true, id }
}
