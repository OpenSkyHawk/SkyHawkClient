import { describe, expect, it } from 'vitest'
import { fileErrorText } from './file-errors'

/** A Node fs error as `openSync` / `renameSync` throw it: code, path and Node's own message. */
const fsError = (code: string, path?: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: node's own wording, open '${path}'`), { code, path })

const TMP = '/Users/me/.userdata/node-mapping.json.bak.tmp'

describe('fileErrorText', () => {
  it.each([
    ['EACCES', 'permission denied in /Users/me/.userdata'],
    ['EPERM', 'permission denied in /Users/me/.userdata'],
    ['ENOSPC', 'the disk is full in /Users/me/.userdata'],
    ['EROFS', 'the disk is read-only in /Users/me/.userdata'],
    ['ENOENT', 'the folder /Users/me/.userdata is missing']
  ])('%s: plain words, naming the folder and not the internal .tmp file', (code, text) => {
    expect(fileErrorText(fsError(code, TMP))).toBe(text)
  })

  it('names the folder of a Windows path too', () => {
    expect(fileErrorText(fsError('EPERM', 'C:\\Users\\me\\AppData\\config.json.tmp'))).toBe(
      'permission denied in C:\\Users\\me\\AppData'
    )
  })

  it('a known code with no path: the plain words alone', () => {
    expect(fileErrorText(fsError('ENOSPC'))).toBe('the disk is full')
    expect(fileErrorText(fsError('EACCES', 'config.json'))).toBe('permission denied')
  })

  it("any other code, or none: the error's own message", () => {
    expect(fileErrorText(fsError('EISDIR', TMP))).toBe(`EISDIR: node's own wording, open '${TMP}'`)
    expect(fileErrorText(new Error('no userData'))).toBe('no userData')
    expect(fileErrorText(Object.assign(new Error('odd'), { code: 'toString' }))).toBe('odd')
    expect(fileErrorText('a string')).toBe('a string')
    expect(fileErrorText(undefined)).toBe('undefined')
  })
})
