import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FIRMWARE_IMAGE,
  FIRMWARE_IMAGE_CRC_VECTORS,
  FIRMWARE_IMAGE_FIELD as F,
  GATEWAY_NODE_ID,
  NODE_KINDS,
  UPL_PROTO
} from '@shared/firmware'
import { checkImageFor, crc32Words, imageCrc32, parseIdentity } from './firmware-image'

/** The 0.3.0 release's cockpit-side image (fixtures/README.md). */
const BRIDGE_030 = new Uint8Array(
  readFileSync(join(__dirname, 'fixtures', 'gateway-bridge-0.3.0.bin'))
)
const BRIDGE = { nodeId: GATEWAY_NODE_ID, nodeKind: NODE_KINDS.BRIDGE }
const AT = FIRMWARE_IMAGE.identityOffset

const put16 = (b: Uint8Array, at: number, v: number) => {
  b[at] = v & 0xff
  b[at + 1] = (v >> 8) & 0xff
}
const put32 = (b: Uint8Array, at: number, v: number) => {
  for (let i = 0; i < 4; i++) b[at + i] = (v >>> (8 * i)) & 0xff
}

/** A stamped image of `length` bytes with an identity block built from `id`, CRC filled in. */
function image(
  id: Partial<{ nodeId: number; nodeKind: number; version: [number, number, number] }> = {},
  length = 2048
): Uint8Array {
  const b = new Uint8Array(length)
  for (let i = 0; i < length; i++) b[i] = (i * 7) & 0xff
  put32(b, AT + F.MAGIC, FIRMWARE_IMAGE.magic)
  put16(b, AT + F.LAYOUT, FIRMWARE_IMAGE.layoutVersion)
  put16(b, AT + F.SIZE, FIRMWARE_IMAGE.blockBytes)
  put32(b, AT + F.LENGTH, length)
  b[AT + F.NODE_ID] = id.nodeId ?? GATEWAY_NODE_ID
  b[AT + F.NODE_KIND] = id.nodeKind ?? NODE_KINDS.BRIDGE
  const [ma, mi, pa] = id.version ?? [1, 0, 1]
  b[AT + F.FW_MAJOR] = ma
  b[AT + F.FW_MINOR] = mi
  b[AT + F.FW_PATCH] = pa
  put32(b, AT + F.CRC, imageCrc32(b, length))
  return b
}

describe('identity.parse', () => {
  it('reads the 0.3.0 release image: node 0, a bridge, 0.3.0, 34,452 bytes', () => {
    expect(BRIDGE_030.length).toBe(34_452)
    const r = parseIdentity(BRIDGE_030)
    expect(r).toEqual({
      ok: true,
      id: expect.objectContaining({
        layoutVersion: 1,
        blockSize: 32,
        imageLength: 34_452,
        nodeId: 0,
        nodeKind: NODE_KINDS.BRIDGE,
        version: '0.3.0'
      })
    })
  })

  it('refuses a file with no identity block (wrong magic)', () => {
    const b = image()
    b[AT + F.MAGIC] ^= 0xff
    expect(parseIdentity(b)).toEqual({ ok: false, why: 'no-magic' })
  })

  it('reads the prefix it knows from a newer layout with a longer block', () => {
    const b = image({ version: [1, 2, 3] })
    put16(b, AT + F.LAYOUT, FIRMWARE_IMAGE.layoutVersion + 1)
    put16(b, AT + F.SIZE, FIRMWARE_IMAGE.blockBytes + 16)
    const r = parseIdentity(b)
    expect(r).toEqual({
      ok: true,
      id: expect.objectContaining({ layoutVersion: 2, blockSize: 48, version: '1.2.3' })
    })
  })

  it('refuses a length past the end of the file', () => {
    const b = image()
    put32(b, AT + F.LENGTH, b.length + 4)
    expect(parseIdentity(b)).toEqual({ ok: false, why: 'length' })
  })

  it('refuses a length that is not whole words, or past the uploader limit', () => {
    const odd = image()
    put32(odd, AT + F.LENGTH, odd.length - 2)
    expect(parseIdentity(odd)).toEqual({ ok: false, why: 'length' })
    const big = image({}, UPL_PROTO.maxImageBytes + 4)
    expect(parseIdentity(big)).toEqual({ ok: false, why: 'length' })
  })

  it('refuses an unstamped build, a file cut before the block, and an unreadable layout', () => {
    const raw = image()
    put32(raw, AT + F.LENGTH, FIRMWARE_IMAGE.unstamped)
    expect(parseIdentity(raw)).toEqual({ ok: false, why: 'unstamped' })
    expect(parseIdentity(BRIDGE_030.slice(0, AT + 8))).toEqual({ ok: false, why: 'too-short' })
    const zero = image()
    put16(zero, AT + F.LAYOUT, 0)
    expect(parseIdentity(zero)).toEqual({ ok: false, why: 'layout' })
  })
})

describe('identity.crc-vectors', () => {
  it('matches both FirmwareImage.h test vectors', () => {
    const word = new Uint8Array(4)
    put32(word, 0, 0x12345678)
    expect(crc32Words(word, 4)).toBe(FIRMWARE_IMAGE_CRC_VECTORS.word12345678)
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => i)
    expect(crc32Words(bytes, 16)).toBe(FIRMWARE_IMAGE_CRC_VECTORS.bytes00to0F)
  })

  it('recomputes the 0.3.0 image’s imageCrc with the CRC word (0x20C) skipped', () => {
    const r = parseIdentity(BRIDGE_030)
    if (!r.ok) throw new Error(r.why)
    expect(AT + F.CRC).toBe(0x20c)
    expect(imageCrc32(BRIDGE_030, r.id.imageLength)).toBe(r.id.imageCrc)
    // Not skipping it gives another value: the skip is what makes the stamp self-consistent.
    expect(crc32Words(BRIDGE_030, r.id.imageLength)).not.toBe(r.id.imageCrc)
  })

  it('a flipped byte is damaged', () => {
    const b = BRIDGE_030.slice()
    b[0x1000] ^= 0x01
    expect(checkImageFor(b, BRIDGE)).toEqual({ ok: false, why: 'damaged' })
  })
})

describe('identity.wrong-board', () => {
  it('the 0.3.0 cockpit-side image is for node 0, a bridge', () => {
    expect(checkImageFor(BRIDGE_030, { ...BRIDGE, version: '0.3.0' }).ok).toBe(true)
  })

  it('refuses another NODE_ID or another kind', () => {
    expect(checkImageFor(image({ nodeId: 3 }), BRIDGE)).toEqual({ ok: false, why: 'wrong-board' })
    expect(checkImageFor(image({ nodeKind: NODE_KINDS.PDU }), BRIDGE)).toEqual({
      ok: false,
      why: 'wrong-board'
    })
  })

  it('refuses another version than the one expected', () => {
    expect(checkImageFor(BRIDGE_030, { ...BRIDGE, version: '1.0.1' })).toEqual({
      ok: false,
      why: 'wrong-version'
    })
  })
})
