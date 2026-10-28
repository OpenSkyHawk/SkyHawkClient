// The renderer's one link to main (R3.4b, P5): the only file that reads `window.skyhawk`.
//
// It binds every topic store's intents to main, and `initBridge` (what App does on mount) pulls the
// current picture and subscribes the push channels — the old single store's initBridge, with each
// pull and push handed to the slice it sets, in the same order.
//
// Each subscription below is a route: main sends every push of one turn as one `push:batch`
// message (R3.4c), and the preload hands that message's pushes to these routes in main's order, in
// one task. Each slice's handler runs as it did per message — the later push wins — and React
// commits the whole turn as one frame.
//
// Two places reach across slices, both as they did in the single store:
//   - the rehydrate bundle (`relay:status`) sets the relay (dcs), the link (gateway) and the
//     calibration (hid/calibration) — three updates, one after another in the same callback, where
//     the single store made one;
//   - `log:batch` (dcs) drops a batch while the Log tab is paused, reading the pause from the events
//     slice at the moment the batch lands (dcs/store.ts, dcs → events).
import { bindConfig, configFromMain } from '../config'
import { bindDcs, dcsFromMain } from '../dcs'
import { bindEvents, eventsFromMain } from '../events'
import { bindGateway, gatewayFromMain } from '../gateway'
import { hidFromMain } from '../hid'
import { bindCalibration, calibrationFromMain } from '../hid/calibration'
import { bindNodes, nodesFromMain } from '../nodes'
import { bindReleases, releasesFromMain } from '../releases'
import { bindUpdate, updateFromMain } from '../update'

/** Main, read at each call: outside Electron there is none, and every intent is a no-op. */
const skyhawk = () => window.skyhawk

bindGateway(skyhawk)
bindDcs(skyhawk)
bindNodes(skyhawk)
bindCalibration(skyhawk)
bindEvents(skyhawk)
bindConfig(skyhawk)
bindReleases(skyhawk)
bindUpdate(skyhawk)

// Guards against duplicate IPC subscriptions (React StrictMode double-mounts the
// init effect in dev; without this every push — and every log row — lands twice).
let bridgeSubscribed = false

export function initBridge(): (() => void) | void {
  const api = window.skyhawk
  if (!api || bridgeSubscribed) return // outside Electron, or already subscribed
  bridgeSubscribed = true

  void api.getHidAvailability().then((a) => hidFromMain.availability(a))

  // Node pushes only fire on change, so a reloaded renderer asks for the current picture.
  void api.getNodes().then(({ model }) => nodesFromMain.nodes(model))

  void api.getConfig().then((v) => configFromMain.config(v))
  void api.getConfigBackups().then((list) => configFromMain.backups(list))

  // Events live in main for the whole app run; a reloaded renderer picks the list back up.
  void api.getEvents().then((rows) => eventsFromMain.restore(rows))

  // The release check and the saved releases live in main; a reloaded renderer asks for them.
  void api.getReleases().then((r) => releasesFromMain.state(r))
  // So does an update in progress (#173): the dialog comes back over the reloaded page.
  void api.getUpdate().then((u) => updateFromMain.state(u))

  // Rehydrate from the live session: a dev reload resets the renderer but the
  // main-process session keeps running, so the UI must not assume "stopped".
  void api.getStatus().then((st) => {
    dcsFromMain.status(st)
    gatewayFromMain.status(st.device)
    calibrationFromMain.status(st.cal)
  })

  const unsubs = [
    api.on('hid:report', (h) => hidFromMain.report(h)),
    api.on('device:status', (d) => gatewayFromMain.status(d)),
    api.on('relay:state', (r) => dcsFromMain.relayState(r)),
    api.on('relay:facts', (f) => dcsFromMain.relayFacts(f)),
    api.on('cal:workflow', (c) => calibrationFromMain.workflow(c)),
    api.on('aircraft:changed', (a) => dcsFromMain.aircraft(a)),
    api.on('nodes:model', (m) => nodesFromMain.model(m)),
    api.on('cockpit:snapshot', (c) => nodesFromMain.cockpit(c)),
    api.on('config:changed', (c) => configFromMain.changed(c)),
    api.on('config:backups', (list) => configFromMain.backups(list)),
    api.on('serial:traffic', (frames) => gatewayFromMain.serialTraffic(frames)),
    api.on('telemetry:tick', (t) => dcsFromMain.telemetry(t)),
    api.on('stats:tick', (st) => dcsFromMain.stats(st)),
    api.on('events:batch', (rows) => eventsFromMain.batch(rows)),
    api.on('log:batch', (rows) => dcsFromMain.logBatch(rows)),
    api.on('releases:state', (r) => releasesFromMain.state(r)),
    api.on('update:state', (u) => updateFromMain.state(u))
  ]

  return () => {
    for (const off of unsubs) off()
    bridgeSubscribed = false
  }
}
