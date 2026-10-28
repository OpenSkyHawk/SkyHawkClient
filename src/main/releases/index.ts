// releases: the firmware release check and the releases saved on this computer (#192). Exports
// only what other topics use (arch-phase0-v2 §2.1): the update flows read their images through
// `Releases.getFile` and the version order from here.
export {
  Releases,
  type CheckFileIO,
  type GetFileResult,
  type ImageEntry,
  type ImageError,
  type ImageForResult,
  type ImageSourceRef,
  type ReleasesDeps
} from './releases'
export { compareVersions, parseVersion, tagVersion, type ImageSelector } from './release-rules'
export type { FetchPort } from './github'
export { registerReleasesIpc } from './ipc'
