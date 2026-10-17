// Text helpers: counts, switches, titles, the empty-value dash, file names and error messages.

/** `1 node`, `3 nodes`; `many` for an irregular plural. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** A boolean setting as the review prints it. */
export const onOff = (b: boolean) => (b ? 'On' : 'Off')

/** `bus-off` → `Bus-off`: the first letter upper-cased. */
export const title = (s: string): string => s[0].toUpperCase() + s.slice(1)

/** What a value with nothing to show reads as. */
export const DASH = '—'

/** `skyhawk-events-….tsv` from a full save path, for the footer's "Saved" note. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** A caught error's message; anything else thrown, as a string. */
export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))
