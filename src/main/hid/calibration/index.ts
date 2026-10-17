// hid/calibration: the axis calibration channel and its cache. Exports only what other topics use
// (arch-phase0-v2 §2.1).
export { CalLink, CalNackError, CalTimeoutError } from './cal-link'
export { loadCalCache, saveCalCache, type CacheFileIO } from './cache-store'
export { boardFor, dropAxis, mergeCalibration, regressedAxes, storeAxes } from './cache-rules'
export { CAL_AXIS_NONE, nackReasonName } from './codec'
