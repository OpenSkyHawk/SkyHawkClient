# Architecture

A guide for contributors: where code lives, which way it may depend, and where a new feature
goes. For what the app does and why, see [PRD.md](./PRD.md).

The short version: **main decides, the renderer draws.** Main owns the hardware, the files and
every rule. It pushes finished state to the renderer. The renderer turns that state into words
and pixels, and sends the user's intents back.

## The process wall

The app is an Electron app with three processes' worth of code, plus code they share.

| Folder          | Runs in              | What it holds                                                                                     |
| --------------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| `src/main/`     | Node (Electron main) | The serial port, HID, the DCS-BIOS network link, files in `<userData>`, and every rule about them |
| `src/preload/`  | The preload script   | The typed bridge `window.skyhawk`, and nothing else                                               |
| `src/renderer/` | The browser window   | React views, one store per topic, presentation helpers                                            |
| `src/shared/`   | Both                 | The IPC contract, the generated firmware reference and pure formatting helpers                    |

The wall is enforced (see [Boundary lint](#boundary-lint)):

- the renderer never imports main or preload, and main never imports the renderer;
- shared code imports nothing from a process;
- the renderer imports only the shared contracts and the two shared leaves (`shared/firmware`,
  `shared/format`);
- only `main/app/` and the preload import `electron`.

## The IPC contract

Each topic has a contract file, `src/shared/<topic>/ipc.ts`. It declares:

- **push channels** (main → renderer): the channel name and the exact shape of its payload;
- **intents** (renderer → main, invoke and reply): the channel name and what it answers;
- the few constants those shapes are defined by, and each pushed state's starting value (what
  the renderer shows before main has said anything).

`src/shared/app/ipc.ts` assembles the topic contracts into one surface: `SkyhawkApi` (what
`window.skyhawk` offers), `PushChannels`, `IPC` (push names) and `CTRL` (intent names). It also
owns the two things that span topics: the `relay:status` rehydrate bundle and the debug intents.

`src/shared/app/ipc.compat.test-d.ts` is the **API guard**: a frozen copy of the whole surface.
`npm run typecheck` fails if the live types drift from it. A PR that changes the API on purpose
updates the frozen copy in the same diff and says why in its header. Channel strings never
change silently.

## Topics

Inside main and inside the renderer, code is grouped by topic. The topics are the same on both
sides:

| Topic             | About                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `app`             | Launch, wiring, the window, IPC registration (main); the shell and tabs that compose several topics (renderer) |
| `gateway`         | The SimGateway USB serial link, its state and the Gateway's own health, the serial monitor                     |
| `dcs`             | The DCS-BIOS relay, its network end, the stream log, stats, recording and replay                               |
| `nodes`           | The CAN node roster, PDU telemetry, the node mapping and the Cockpit snapshot                                  |
| `hid`             | The HID joystick report                                                                                        |
| `hid/calibration` | Axis calibration: the protocol, the workflow and the restore cache                                             |
| `events`          | The event log                                                                                                  |
| `config`          | The settings, and configuration export and import                                                              |

The renderer also has `app/kit/`: UI primitives (`Dialog`, `Sheet`, `Row`, icons) and the nav
store. It is a leaf that every renderer topic may use.

### `index.ts` is the only door

Every topic folder has an `index.ts`. It exports what other topics may use, and nothing else. A
file outside a topic imports only that topic's `index.ts`, never a file inside it. A topic's own
files import each other freely.

### Allowed directions

A topic may import only the topics in its row, plus the shared contracts, `shared/firmware`,
`shared/format` and (in the renderer) `app/kit`. The table is the same in main and the renderer.

| From              | May import                 |
| ----------------- | -------------------------- |
| `app`             | every topic                |
| `config`          | `nodes`, `hid/calibration` |
| `nodes`           | `gateway`, `events`        |
| `dcs`             | `gateway`, `events`        |
| `hid/calibration` | `hid`, `gateway`           |
| `hid`             | `gateway`                  |
| `gateway`         | `events`                   |
| `events`          | nothing                    |

There are no import cycles anywhere, type-only imports included. When two topics need the same
thing, it belongs to the lower one, or to a contract.

## Roles

Each file plays one role.

| Role           | Where    | What it does                                                                                                        | Example                                                                                                            |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Model**      | main     | Pure rules. No I/O; time is passed in. Stateful classes count if they do no I/O.                                    | `main/gateway/gateway-health.ts` `gatewayStatus`: the worst Gateway problem from a status row                      |
| **Service**    | main     | Stateful, with side effects: owns a resource, calls the models, pushes the result. Never re-derives a model's rule. | `main/nodes/node-hub.ts` `NodeHub`: the roster, the mapping file and the `nodes:model` / `cockpit:snapshot` pushes |
| **View-model** | renderer | Presentation only: pushed state into words, CSS classes and geometry. Decides nothing.                              | `renderer/src/gateway/gateway-view.ts` `gatewayView`: the pill class, popover title and Health row                 |
| **View**       | renderer | React components that read a store and call its intents.                                                            | `renderer/src/gateway/DevicePopover.tsx`                                                                           |

Some main files build what a push carries from the models' answers, purely: the Cockpit
snapshot (`main/nodes/cockpit-snapshot/`), the relay's facts (`main/dcs/relay-rules.ts`), the
calibration view (`main/hid/calibration/calibration-view-model.ts`). They are models: they
decide, and the renderer only words what they decided.

**One owner per rule.** Each rule lives in exactly one place, and every surface that needs its
answer reads it from there. If the Overview and the Cockpit must agree on a count, both read the
same field of the same push.

## Who owns what

| Topic             | Main owner                                                                                                                                              | Pushes                                                                                        | Renderer store          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------- |
| `gateway`         | `GatewayConnection` (the port and its state), `SerialTrafficMonitor`; the Gateway's health rules (`gateway-health`)                                     | `device:status`, `serial:traffic`                                                             | `useGatewayStore`       |
| `dcs`             | `DcsRelay` (Start/Stop, source mode, what the relay's surfaces show), `DcsConnection`, `StreamLog`, `Stats`, `SessionRecorder`                          | `relay:state`, `relay:facts`, `aircraft:changed`, `telemetry:tick`, `stats:tick`, `log:batch` | `useDcsStore`           |
| `nodes`           | `NodeHub` (roster, telemetry, mapping; it also feeds the Gateway's health from the node status rows), its `MappingStore`, and the Cockpit snapshot host | `nodes:model`, `cockpit:snapshot`                                                             | `useNodesStore`         |
| `hid`             | `HidService`                                                                                                                                            | `hid:report`                                                                                  | `useHidStore`           |
| `hid/calibration` | `HidCalibrationService` and the workflow it hosts                                                                                                       | `cal:workflow`                                                                                | `useCalibrationStore`   |
| `events`          | `EventJournal`                                                                                                                                          | `events:batch`                                                                                | `useEventsStore`        |
| `config`          | `SettingsService` (the settings), `ConfigTransfer` (export / import), `BackupFolder` (automatic backups)                                                | `config:changed`, `config:backups`                                                            | `useConfigStore`        |
| `app`             | `AppServices` (builds and wires the services; no rules, no state)                                                                                       | —                                                                                             | `useNav` (in `app/kit`) |

## How a screen gets its data

```
main service ──emit──▶ push:batch ──▶ preload ──▶ ipc-adapter ──▶ topic store ──▶ view
     ▲                                                                              │
     └───────────────── intent (invoke) ◀── topic store intent ◀── user action ◀────┘
```

1. A main service changes something and calls `emit(channel, payload)` with the finished state.
2. The push travels in a `push:batch` (below) and the preload hands it to the subscribers of its
   channel.
3. `renderer/src/app/ipc-adapter.ts` is the only renderer file that touches `window.skyhawk`. It
   subscribes every push channel and routes each push to its topic store's `<topic>FromMain`
   handler.
4. The store holds what main pushed. Views read the store and render it through their
   view-models.
5. A user action calls an intent on the topic store (`forgetNode`, `toggleRelay`, …). The store
   calls main through the binding the adapter gave it (`bind<Topic>`). Main acts, then pushes the
   new state. The renderer never edits its own copy of main's state to fake the result.

When the renderer loads (or reloads in dev while main keeps running) the adapter also pulls the
current picture: `relay:status`, `nodes:get`, `config:get`, `config:backups-get`, `events:get`,
`hid:availability`.

## `push:batch`: one frame per main turn

One main event often fans out to several pushes. A link drop, for example, changes
`device:status`, `cal:workflow`, `cockpit:snapshot` and `relay:facts`. Sent one by one, the
renderer could draw between them and show half the change.

So main never sends a push on its own channel. `main/app/push-batch.ts` collects every push made
during one synchronous main turn and sends them as one `push:batch` message, in order, from a
microtask at the end of the turn. The preload hands that message's pushes to their subscribers in
one task, and React draws them as one frame. Nothing is merged or dropped. `SkyhawkApi.on(channel,
cb)` is still the per-channel subscription; the batching is invisible to stores and views.

## Firmware values come from `npm run sync`

Protocol numbers, report layouts, node names, flag bits and USB identity come from the
OpenSkyhawk firmware repo. `scripts/sync-a4ec.ts` (`npm run sync`) reads them from a pinned
firmware commit and writes `src/shared/firmware/*.generated.ts`.

- Import them from `@shared/firmware`; never type a firmware value by hand.
- Never edit a generated file. Change the generator (or the pinned commit) and run `npm run sync`.
- CI re-runs the sync and fails if the committed files differ.
- The one hand-curated exception is the DCS-BIOS common-metadata address (`_ACFT_NAME`), which
  the firmware repo does not carry; it lives in `main/dcs/bios-protocol.ts`.

## The settings store

`SettingsService` (`main/config/`) owns the live settings: one zustand vanilla store under
`subscribeWithSelector`, loaded from `config.json` and saved back on each change. Services that
need settings are handed the read-only `SettingsStore` view of that same instance. They read it
with `getState()` when they need a value, and react with `subscribe(selector, listener)`.

Only `SettingsService` writes it. A change from the renderer is an intent (`config:set`,
`config:edit`); main builds the new settings, saves them and pushes `config:changed`.

Other ports are injected the same way. `AppServices` hands each service what it needs (the
`<userData>` file paths, the debug log, the `emit` function, the Gateway link) so no service
imports `app/` or asks electron itself.

## Adding a feature

Work from the wire inwards, then outwards to the view.

| Piece                                     | Where it goes                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A new firmware value                      | The firmware repo first, then the generator in `scripts/sync-a4ec.ts`, then `npm run sync`           |
| The rule (what it means)                  | A model in `src/main/<topic>/`, pure, with unit tests beside it                                      |
| The state it changes, and when            | The topic's service in `src/main/<topic>/`, which calls the model and pushes                         |
| The pushed shape, a new channel or intent | `src/shared/<topic>/ipc.ts`; update the API guard on purpose                                         |
| Wiring between services                   | `main/app/app-services.ts` only                                                                      |
| A new intent's handler                    | The topic's `main/<topic>/ipc.ts` (`register<Topic>Ipc`), plus its slot in `main/app/ipc.ts`'s order |
| Holding the push in the renderer          | The topic store's `<topic>FromMain`, routed in `app/ipc-adapter.ts`                                  |
| Words, classes, geometry                  | A view-model beside the view, in `src/renderer/src/<topic>/`                                         |
| The component                             | `src/renderer/src/<topic>/` (or `app/` if it composes several topics)                                |
| Shared formatting both sides use          | `src/shared/format/`                                                                                 |

If the renderer needs to decide something, that decision belongs in main: push the answer
instead. If another topic needs your code, export it from your `index.ts`, and check the
direction table first.

## Boundary lint

Two tools enforce the structure. Both run in CI.

- **`npm run lint:deps`** runs dependency-cruiser with `.dependency-cruiser.cjs`. It checks the
  process wall, the contract and leaf rules, the topic directions, the "index.ts only" rule, and
  cycles.
- **ESLint rule P5** (`eslint.config.mjs`, part of `npm run lint`) checks the one thing a
  dependency graph can't see: only `renderer/src/app/ipc-adapter.ts` may touch `window.skyhawk`.

Each dependency-cruiser rule family takes its severity from
`.dependency-cruiser.severity.json`, one key per family. Every family is `error`. A new rule can
start at `warn` there while existing code is brought in line, then move to `error`.

## Tests

| Layer         | Runs      | Looks at                                                                                                                                                                                                           | Where                                 |
| ------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| **Unit**      | node      | One model or service, directly                                                                                                                                                                                     | `*.test.ts` beside the code           |
| **Seam**      | node      | The whole main process through `makeServices()` (`main/test-harness/services.ts`), with the serial port, DCS transport, HID, clock and `<userData>` faked. A test sees only pushes, intents, files and wire bytes. | `*.seam.test.ts`                      |
| **Component** | jsdom     | A rendered view, through the real IPC adapter and stores                                                                                                                                                           | `src/renderer/test/t*.test.tsx`       |
| **API guard** | typecheck | The IPC surface's types                                                                                                                                                                                            | `src/shared/app/ipc.compat.test-d.ts` |

**Component tests describe main's world, not the renderer's state.** A test builds a `Scenario`
(the link, the relay, the node model, the config, …) and calls `emitScenario`. The mock
(`src/renderer/test/skyhawk-mock.ts`) pushes it the way main does, on the real channels and in
`push:batch` turns, and it runs **main's own builders** for the pushes main derives: the Cockpit
snapshot host, the calibration workflow host, the relay's facts, the HID facts. So the component
under test draws what main would really push. Tests never set store fields and never push by
hand; they assert roles and visible text, not pixels or internal calls. Shared builders for
scenarios are in `src/renderer/test/scenarios.ts` and `src/test-fixtures/`.

**Structure changes come with proofs.** A refactor that must not change behaviour also proves it,
outside the test suite: a **render proof** records every DOM state each component test passes
through, before and after, and compares the sequences; a **trace proof** drives main through
scripted scenarios and records every push, wire byte, timer and file write, before and after. The
PR body reports both.

Run everything with `npm test`, `npm run lint`, `npm run lint:deps` and `npm run typecheck`.
