// DCS-BIOS session capture format (pure serialize/parse, no fs). A superset of
// the firmware repo's dcsbios_data.json: adds per-event direction + session
// metadata while keeping hex-encoded raw bytes so a basic replayer can still read it.

export interface CaptureEvent {
  /** Milliseconds since capture start. */
  t: number
  /** "in" = export from DCS, "out" = command toward DCS. */
  dir: 'in' | 'out'
  /** Hex-encoded raw bytes. */
  hex: string
}

export interface CaptureMeta {
  aircraft?: string
  note?: string
}

export interface CaptureFile extends CaptureMeta {
  format: 'skyhawk-capture/1'
  createdAt: string
  events: CaptureEvent[]
}

export const CAPTURE_FORMAT = 'skyhawk-capture/1'

export function serializeCapture(events: CaptureEvent[], meta: CaptureMeta = {}): string {
  const file: CaptureFile = {
    format: CAPTURE_FORMAT,
    createdAt: new Date().toISOString(),
    ...meta,
    events
  }
  return JSON.stringify(file, null, 2)
}

export function parseCapture(text: string): CaptureFile {
  const obj = JSON.parse(text) as Partial<CaptureFile>
  if (obj.format !== CAPTURE_FORMAT) {
    throw new Error(`unrecognized capture format: ${String(obj.format)}`)
  }
  if (!Array.isArray(obj.events)) {
    throw new Error('capture has no events array')
  }
  return obj as CaptureFile
}

/** Total capture duration in ms (timestamp of the last event, or 0). */
export function captureDurationMs(file: CaptureFile): number {
  return file.events.length ? file.events[file.events.length - 1]!.t : 0
}
