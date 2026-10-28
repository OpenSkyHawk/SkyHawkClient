// The Gateway uploader's channel (#187): the calibration link's requests and unsolicited frames,
// as the update topic's uploader client takes them. app owns the seam because update imports no
// other topic: hid/calibration's CalLink keeps the envelope, SEQ and timeouts, update the UPL_*
// payloads.
import { CalNackError, CalTimeoutError, type CalLink } from '../hid/calibration'
import type { UploaderLink } from '../update'

export function uploaderLink(cal: Pick<CalLink, 'exchange' | 'onUnsolicited'>): UploaderLink {
  return {
    exchange: async (type, payload, timeoutMs) => {
      try {
        const f = await cal.exchange(type, payload, timeoutMs)
        return { ok: true, frame: { type: f.type, payload: f.payload } }
      } catch (e) {
        if (e instanceof CalNackError) return { ok: false, nack: e.reason }
        if (e instanceof CalTimeoutError) return { ok: false, timeout: true }
        throw e
      }
    },
    onUnsolicited: (cb) => cal.onUnsolicited((f) => cb({ type: f.type, payload: f.payload }))
  }
}
