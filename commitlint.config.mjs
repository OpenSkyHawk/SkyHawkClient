// Enforce Conventional Commits so the commit type drives the release version
// (release-please: feat -> minor, fix -> patch, breaking -> minor while < 1.0).
export default {
  extends: ['@commitlint/config-conventional']
}
