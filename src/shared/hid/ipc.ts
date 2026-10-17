// HID topic contract (arch-phase0-v2 §2.3): the Gateway's joystick report as the client reads it.
// Imported by main, preload and the renderer.

export interface HidSnapshot {
  axes: number[] // 8 signed
  buttons: boolean[] // 128
  hats: number[] // 4 (0 = centre)
  ageMs: number // time since last report; large => idle
  rateHz: number // reports/sec (on-change; 0 when idle)
}

/** Report indices the firmware actually catalogues (the rest dim in the HID panel). */
export interface HidAvailability {
  axes: number[]
  hats: number[]
  buttons: number[]
}

/** This topic's main -> renderer pushes; shared/app assembles them into `PushChannels`. */
export interface HidPushChannels {
  'hid:report': HidSnapshot
}

/** Push channel names (main -> renderer). */
export const HID_PUSH = {
  hidReport: 'hid:report'
} as const

/** Intent channel names (renderer -> main, invoke/response). */
export const HID_CTRL = {
  hidAvailability: 'hid:availability'
} as const
