// A file-system error in plain words (#136): the one wording of why a file under <userData> could
// not be saved or put back, wherever it is shown — the event rows of config.json and
// calibration-cache.json, node-mapping.json's "not saved" answers, and a config import's answer.
// Here, in the format leaf, because each file's owner (config, nodes, hid/calibration) words its
// own failures and none of them may import another's.
import { errorText } from './text'

/** The Node error codes said in plain words. Any other code shows the error's own message. */
const PLAIN = new Map<string, string>([
  ['EACCES', 'permission denied'],
  ['EPERM', 'permission denied'],
  ['ENOSPC', 'the disk is full'],
  ['EROFS', 'the disk is read-only'],
  ['ENOENT', 'the folder is missing']
])

/** The folder a path is in, by either separator; undefined when the path names none. */
function folderOf(path: string): string | undefined {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (i < 0) return undefined
  return i === 0 ? path.slice(0, 1) : path.slice(0, i)
}

/**
 * Why a file operation failed, in plain words, naming the folder rather than the file it was
 * writing (often an internal `.tmp`): `permission denied in /Users/me/.userdata`, `the folder
 * /Users/me/.userdata is missing`. An error with any other code, or none, shows its own message.
 */
export function fileErrorText(err: unknown): string {
  const e = err as { code?: unknown; path?: unknown } | null | undefined
  const code = typeof e?.code === 'string' ? e.code : undefined
  const words = code === undefined ? undefined : PLAIN.get(code)
  if (words === undefined) return errorText(err)
  const dir = typeof e?.path === 'string' ? folderOf(e.path) : undefined
  if (dir === undefined) return words
  return code === 'ENOENT' ? `the folder ${dir} is missing` : `${words} in ${dir}`
}
