import { describe, expect, it } from 'vitest'
import {
  CAL_PAYLOAD_LEN,
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
  UPL_TARGET
} from '@shared/firmware'
import {
  UPL_TYPE,
  decodeInfoAck,
  decodeResult,
  decodeStatus,
  encodeBegin,
  encodeData,
  encodeFlash
} from './upl-codec'

const len = (name: keyof typeof UPL_TYPE) => CAL_PAYLOAD_LEN[UPL_TYPE[name]]

describe('uploader.messages: encoded at the synced offsets', () => {
  it('UPL_BEGIN carries the length and CRC, little-endian, at its legal length', () => {
    const p = encodeBegin(34_452, 0xfb5b5f57)
    expect(p.length).toBe(len('UPL_BEGIN'))
    expect([...p.subarray(UPL_BEGIN_FIELD.LENGTH, UPL_BEGIN_FIELD.LENGTH + 4)]).toEqual([
      0x94, 0x86, 0, 0
    ])
    expect([...p.subarray(UPL_BEGIN_FIELD.CRC, UPL_BEGIN_FIELD.CRC + 4)]).toEqual([
      0x57, 0x5f, 0x5b, 0xfb
    ])
  })

  it('UPL_DATA is the offset and one whole chunk; the last chunk is 0xFF-padded', () => {
    const image = Uint8Array.from({ length: 600 }, (_, i) => i & 0x7f)
    const first = encodeData(image, 600, 0)
    expect(first.length).toBe(len('UPL_DATA'))
    expect(first[UPL_DATA_FIELD.BYTES + 255]).toBe(image[255])
    const last = encodeData(image, 600, 512)
    expect(last[UPL_DATA_FIELD.OFFSET + 1]).toBe(2) // 512, little-endian
    expect(last[UPL_DATA_FIELD.BYTES]).toBe(image[512])
    expect(last[UPL_DATA_FIELD.BYTES + 600 - 512 - 1]).toBe(image[599])
    // Past imageLength: padding, not whatever else the file holds.
    expect([...last.subarray(UPL_DATA_FIELD.BYTES + 600 - 512)].every((b) => b === 0xff)).toBe(true)
    expect(UPL_DATA_FIELD.BYTES + UPL_PROTO.chunkBytes).toBe(len('UPL_DATA'))
  })

  it('UPL_FLASH takes the target as a parameter: the cockpit side (0) or a board (3)', () => {
    for (const target of [UPL_TARGET.bridge, 3]) {
      const p = encodeFlash(target, UPL_TARGET.nodeIdKeep)
      expect(p.length).toBe(len('UPL_FLASH'))
      expect(p[UPL_FLASH_FIELD.TARGET]).toBe(target)
      expect(p[UPL_FLASH_FIELD.NEW_NODE_ID]).toBe(0xff)
    }
  })
})

describe('uploader.messages: decoded at the synced offsets', () => {
  it('UPL_INFO_ACK: state, the last flash, and the bundled cockpit-side version', () => {
    const p = new Uint8Array(len('UPL_INFO_ACK')!)
    p[INFO.PROTO] = 1
    p[INFO.MAX_IMAGE_KB] = 124
    p[INFO.CHUNK] = 0
    p[INFO.CHUNK + 1] = 1 // 256
    p[INFO.STATE] = UPL_STATE.STAGED
    p[INFO.LAST_TARGET] = 0
    p[INFO.LAST_RESULT] = UPL_RESULT.OK
    p.set([1, 0, 1], INFO.LAST_MAJOR)
    p.set([1, 0, 1], INFO.BRIDGE_MAJOR)
    expect(decodeInfoAck(p)).toEqual({
      proto: 1,
      maxImageBytes: UPL_PROTO.maxImageBytes,
      chunkBytes: UPL_PROTO.chunkBytes,
      state: 'STAGED',
      lastTarget: 0,
      lastResult: 'OK',
      lastFw: '1.0.1',
      bridgeFw: '1.0.1'
    })
  })

  it('UPL_INFO_ACK: 0.0.0 is no version, no bundle; an unknown state reads undefined', () => {
    const p = new Uint8Array(len('UPL_INFO_ACK')!)
    p[INFO.STATE] = 0x7f
    const info = decodeInfoAck(p)
    expect(info.state).toBeUndefined()
    expect(info.lastResult).toBe('NONE')
    expect(info).not.toHaveProperty('lastFw')
    expect(info).not.toHaveProperty('bridgeFw')
  })

  it('UPL_STATUS: phase, target, attempt and blocks', () => {
    const p = new Uint8Array(len('UPL_STATUS')!)
    p[STATUS.PHASE] = UPL_PHASE.WRITING
    p[STATUS.TARGET] = 0
    p[STATUS.ATTEMPT] = 1
    p.set([0x0d, 0x01], STATUS.BLOCK) // 269
    p.set([0x1b, 0x02], STATUS.BLOCKS) // 539
    expect(decodeStatus(p)).toEqual({
      phase: 'WRITING',
      target: 0,
      attempt: 1,
      block: 269,
      blocks: 539
    })
  })

  it('UPL_RESULT: result, target, the version reported, tries and time', () => {
    const p = new Uint8Array(len('UPL_RESULT')!)
    p[RESULT.RESULT] = UPL_RESULT.WRITE_FAILED
    p[RESULT.TARGET] = 3
    p[RESULT.ATTEMPTS] = 3
    p.set([7, 0], RESULT.SECONDS)
    expect(decodeResult(p)).toEqual({
      via: 'result',
      result: 'WRITE_FAILED',
      target: 3,
      attempts: 3,
      seconds: 7
    })
  })
})
