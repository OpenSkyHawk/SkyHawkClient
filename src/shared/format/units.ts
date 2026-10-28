// Unit helpers: volts and amps from milli-units, byte rates, percentages and hex.

/** Millivolts as `12.00 V`. */
export const volts = (mv: number): string => `${(mv / 1000).toFixed(2)} V`

/** Millivolts as `12.00`, no unit: where the label or column already says V. */
export const voltsValue = (mv: number) => (mv / 1000).toFixed(2)

/** Milliamps as `1.25 A`. */
export const amps = (ma: number): string => `${(ma / 1000).toFixed(2)} A`

/** A byte rate: `512 B/s` below 1 KB, `2.0 KB/s` from there. */
export function fmtBytes(n: number): string {
  return n >= 1024 ? (n / 1024).toFixed(1) + ' KB/s' : Math.round(n) + ' B/s'
}

/** `4.6%` under 10 %, `53%` from there. */
export function fmtPct(pct: number): string {
  const one = Number(pct.toFixed(1))
  return one < 10 ? `${one.toFixed(1)}%` : `${Math.round(pct)}%`
}

/** The low byte as two upper-case hex digits: `0x1a2b` → `2B`. */
export const hex2 = (n: number) => (n & 0xff).toString(16).toUpperCase().padStart(2, '0')

/** The low 16 bits as `0x` + four upper-case hex digits: `0x1A2B`. */
export const hex4 = (n: number) => '0x' + (n & 0xffff).toString(16).toUpperCase().padStart(4, '0')

/** A one-byte code as the firmware writes it (FP 04, D22): `0xEE`; `?` when there is none. */
export const hexCode = (n: number | undefined): string => (n === undefined ? '?' : '0x' + hex2(n))
