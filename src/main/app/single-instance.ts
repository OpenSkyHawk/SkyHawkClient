// One running app per <userData> (D4/M5). Two instances on one folder overwrote each other's
// config.json, node-mapping.json and calibration cache; now a second launch hands over and quits.
//
// Electron keys the lock to the userData folder, so the caller asks only after any
// `setPath('userData', …)`: two dev worktrees (each with its own folder, #81) still run side by
// side, while a second launch on the same folder does not.

/** The slice of electron's `app` the lock needs. */
export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean
  quit(): void
  on(event: 'second-instance', listener: () => void): unknown
}

/** The slice of a `BrowserWindow` a second launch brings forward. */
export interface FocusableWindow {
  isMinimized(): boolean
  restore(): void
  focus(): void
}

/**
 * Takes the single-instance lock. `true`: this is the only instance, carry on; a later launch on
 * the same <userData> brings the app in front of the user. It restores `window()` if minimised
 * and focuses it; with no window (macOS keeps running with every window closed) it does what
 * `activate` does, `create()` one, then focuses that. `false`: another instance holds the lock
 * and has been told; this one is quitting, and the caller must stop.
 */
export function claimSingleInstance(
  app: SingleInstanceApp,
  window: () => FocusableWindow | null,
  create: () => void
): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return false
  }
  app.on('second-instance', () => {
    const open = window()
    if (open?.isMinimized()) open.restore()
    if (!open) create()
    window()?.focus()
  })
  return true
}
