// hid/calibration: the axis calibration channel and its cache. Exports only what other topics use
// (arch-phase0-v2 §2.1).
export { HidCalibrationService } from './hid-calibration-service'
export { loadCalCache, saveCalCache, type CacheFileIO } from './cache-store'
export { mergeCalibration } from './cache-rules'
