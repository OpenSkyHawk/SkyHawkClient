// Node fault and flag text (pure, no Node/Electron deps): what a raised PDU rail or status flag is
// called in an event row, and the reading that goes with it.
import type { EventSeverity } from '@shared/events'
import { amps, volts } from '@shared/format'
import type { PduRailPage } from '@shared/nodes'
import { displayCurrentMa, PDU_FLAG, RAIL_FLAG } from '@shared/nodes/legacy-rules'

/** Rail flag text, as the Cockpit prints it (`5V UNDER-V`). */
export const RAIL_FLAGS: [number, string][] = [
  [RAIL_FLAG.UNDER_V, 'UNDER-V'],
  [RAIL_FLAG.OVER_V, 'OVER-V'],
  [RAIL_FLAG.OVER_CURRENT, 'OVER-I'],
  [RAIL_FLAG.FUSE_OPEN, 'FUSE OPEN'],
  [RAIL_FLAG.SENSOR_FAULT, 'SENSOR FAULT']
]

/** UNCAL_* are calibration state, not alerts (as on the Cockpit), so they are info. */
export const PDU_STATUS_FLAGS: [number, string, EventSeverity][] = [
  [PDU_FLAG.TEMP_CRIT, 'TEMP CRIT', 'warn'],
  [PDU_FLAG.TEMP_WARN, 'TEMP WARN', 'warn'],
  [PDU_FLAG.NTC_FAULT, 'NTC FAULT', 'warn'],
  [PDU_FLAG.UNCAL_VDDA, 'UNCAL VDDA', 'info'],
  [PDU_FLAG.UNCAL_ZERO, 'UNCAL ZERO', 'info']
]

export const TEMP_FLAGS = PDU_FLAG.TEMP_CRIT | PDU_FLAG.TEMP_WARN

/** The reading that goes with a raised rail flag: the window minimum for under-voltage. */
export function railReading(bit: number, p: PduRailPage): string {
  if (bit === RAIL_FLAG.UNDER_V) return volts(p.vMinMv)
  if (bit === RAIL_FLAG.OVER_CURRENT) return amps(displayCurrentMa(p.iAvgMa))
  return volts(p.vAvgMv)
}
