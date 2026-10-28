// A rough duration, as the update dialogs say it (#173 owns the rule; #187, #175 and #176 use it):
// under 60 s in seconds, from 60 s up in whole minutes, rounded to the nearest.

/** `about 5 s`, `about 1 min`. */
export function aboutSeconds(seconds: number): string {
  const s = Math.round(seconds)
  return s < 60 ? `about ${s} s` : `about ${Math.round(s / 60)} min`
}
