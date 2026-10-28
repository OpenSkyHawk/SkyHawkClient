// A stamped board image (test-only: no production code may import this folder): an identity block
// at FirmwareImage.h's offsets, CRC filled in, as the firmware build's stamp step writes it.
import {
  FIRMWARE_IMAGE,
  FIRMWARE_IMAGE_FIELD as F,
  GATEWAY_NODE_ID,
  NODE_KINDS
} from '@shared/firmware'
import { imageCrc32 } from '../main/update/firmware-image'

const AT = FIRMWARE_IMAGE.identityOffset

const put16 = (b: Uint8Array, at: number, v: number) => {
  b[at] = v & 0xff
  b[at + 1] = (v >> 8) & 0xff
}
const put32 = (b: Uint8Array, at: number, v: number) => {
  for (let i = 0; i < 4; i++) b[at + i] = (v >>> (8 * i)) & 0xff
}

/** An image for `nodeId` / `nodeKind` (default: the Gateway's cockpit side) at `version`. */
export function stampedImage(
  version: string,
  id: Partial<{ nodeId: number; nodeKind: number }> = {},
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
  const [ma, mi, pa] = version.split('.').map(Number)
  b[AT + F.FW_MAJOR] = ma ?? 0
  b[AT + F.FW_MINOR] = mi ?? 0
  b[AT + F.FW_PATCH] = pa ?? 0
  put32(b, AT + F.CRC, imageCrc32(b, length))
  return b
}
