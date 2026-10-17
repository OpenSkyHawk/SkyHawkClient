// HID topic contract (arch-phase0-v2 §2.3): the Gateway's joystick report as the client reads it.
// Imported by main, preload and the renderer.

export interface HidSnapshot {
  axes: number[] // 8 signed
  buttons: boolean[] // 128
  hats: number[] // 4 (0 = centre)
  ageMs: number // time since last report; large => idle
  rateHz: number // reports/sec (on-change; 0 when idle)
}

/** How recently the device last reported: live under 1 min, idle under 5, then quiet. */
export type HidFreshness = 'live' | 'idle' | 'quiet'

/**
 * What HidService concludes for the HID tab (R3.3), pushed with every report: main decides it
 * (main/hid/hid-facts.ts), the renderer only reads it.
 */
export interface HidReportFacts {
  /** The report's age as a band. While the board is absent the tab says "no link" instead. */
  band: HidFreshness
  /** Axis slots this Gateway's sketch declares (presentMask); 0 until it has reported. */
  present: number
  /** Per axis slot: catalogued and declared — the catalogue alone until the device reports. */
  axisLive: boolean[]
}

/** `hid:report` as main pushes it: the report and what it means for the HID tab. */
export type HidReport = HidSnapshot & HidReportFacts

/** Report indices the firmware actually catalogues (the rest dim in the HID panel). */
export interface HidAvailability {
  axes: number[]
  hats: number[]
  buttons: number[]
}

/** This topic's main -> renderer pushes; shared/app assembles them into `PushChannels`. */
export interface HidPushChannels {
  'hid:report': HidReport
}

/** Push channel names (main -> renderer). */
export const HID_PUSH = {
  hidReport: 'hid:report'
} as const

/** Intent channel names (renderer -> main, invoke/response). */
export const HID_CTRL = {
  hidAvailability: 'hid:availability'
} as const
