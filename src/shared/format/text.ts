// Text helpers: counts, switches, titles, the empty-value dash, unknown codes, file names and error
// messages.

import { hexCode } from './units'

/** `1 node`, `3 nodes`; `many` for an irregular plural. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** A boolean setting as the review prints it. */
export const onOff = (b: boolean) => (b ? 'On' : 'Off')

/** `bus-off` → `Bus-off`: the first letter upper-cased. */
export const title = (s: string): string => s[0].toUpperCase() + s.slice(1)

/**
 * A code this client has no label for: `what` in lower case, then the code in hex (FP 04, D22).
 * One case rule: 'sentence' = `Unknown fault (0xEE)`, 'word' = `unknown fault (0xEE)` inside a
 * lower-case list, 'badge' = `UNKNOWN FAULT (0xEE)`. Only the words change case, never the code.
 */
export function unknownLabel(
  what: string,
  code: number | undefined,
  form: 'sentence' | 'word' | 'badge' = 'sentence'
): string {
  const words = `unknown ${what}`
  const head = form === 'badge' ? words.toUpperCase() : form === 'sentence' ? title(words) : words
  return `${head} (${hexCode(code)})`
}

/** What a value with nothing to show reads as. */
export const DASH = '—'

/** `skyhawk-events-….tsv` from a full save path, for the footer's "Saved" note. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** A caught error's message; anything else thrown, as a string. */
export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** A firmware release as the UI writes it: `1.0.1`. */
export const versionText = (v: { major: number; minor: number; patch: number }): string =>
  `${v.major}.${v.minor}.${v.patch}`
