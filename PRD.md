# PRD — SkyHawkClient (OpenSkyhawk SimGateway connector + monitor)

Repo: `git@github.com:OpenSkyHawk/SkyHawkClient.git` (already created, empty). Standalone, cross-platform (Windows + macOS) Electron + TypeScript + React desktop app.

## 1. Context — why this exists

Today the cockpit connects to DCS via `Firmware/ScratchPad/Arduino_Tools/connect-serial-port.cmd`: a bare **`socat` relay** that the user must run from a console. It owns the SimGateway COM port and bridges DCS-BIOS ↔ serial both ways, but it is Windows-only (`.cmd` + bundled `socat.exe`), has **no UI**, no port auto-detect (prompts for a COM number), no visibility into connection health, which aircraft is loaded, the DCS-BIOS traffic, or the HID joystick state. There is no macOS equivalent.

SkyHawkClient replaces that connector with one branded, cross-platform GUI app that **is the bridge AND the monitor**: it auto-detects the SimGateway, relays the DCS-BIOS stream exactly like `socat` did, and surfaces connection / aircraft / stats / a decoded live log / full per-element HID status. Outcome: a builder plugs in the cockpit, opens one app, and sees everything is alive — replacing a console window and a blind socket relay.

**Reference precedent:** DCS-Skunkworks/**Bort** (Electron + TS, GPL-3.0) is the wrapper pattern, but Bort only reads _static_ DCS-BIOS `Controls.json` — it is not a live serial bridge. SkyHawkClient reuses Bort's desktop-wrapper shape and the same A-4E-C control-reference JSON, but adds the live serial relay + HID that Bort lacks.

## 2. Goals / Non-goals

**Goals (v1, "Lean MVP"):**

- Drop-in functional replacement for `connect-serial-port.cmd` on Windows **and** macOS.
- Auto-detect the SimGateway (USB VID `0x2E8A` / PID `0x4134`); manual port override.
- Bidirectional DCS-BIOS relay, byte-for-byte, in the live data path.
- Dashboard: connection state, aircraft loaded, stream/command/telemetry stats.
- Live **decoded** DCS-BIOS log (control names + values) with filter/search, pause/autoscroll, export, raw↔decoded toggle.
- Full live **HID status**: every axis / button / hat decoded from the SimGateway HID interface.
- Protocol constants kept in sync with the firmware via a committed sync script.
- **Remote DCS:** Bridge mode works with DCS on a _different machine_ — SimGateway plugged into _this_ computer (e.g. a Mac) while DCS runs on a Windows PC, reached over the LAN (TCP-connect `<DCS-host>:7778` and/or `BIOSConfig.lua` unicast export). One-click "Connect to remote DCS" in setup.
- **Monitor mode (no device):** source DCS-BIOS straight off the LAN to inspect/test the stream with no SimGateway — incl. this app on macOS, DCS on Windows. Serial relay + HID inactive.
- **Record + Replay:** capture a live DCS-BIOS session to a file and replay it as a synthetic source (drive the parser/UI, and optionally the SimGateway serial) to exercise panels/UI with **no DCS running**.
- **Non-A-4E aircraft:** if another module loads, show a warning banner but **still relay + collect stats** (raw/address-level; named decode stays A-4E-C-only).

**Non-goals (v1, deferred):**

- Signed installers, auto-update, system tray, launch-on-boot.
- Multiple devices / legacy one-Arduino-per-panel (`multiple-com-ports.cmd`) setups — single SimGateway only.
- Editing/sending arbitrary DCS-BIOS commands from the UI (commands originate from the cockpit or from replay).
- Named decoding for non-A-4E modules (warning + raw only).
- Showing connected PanelGroup nodes — needs new firmware reporting; tracked as a future issue (§12).

## 3. Users

OpenSkyhawk builders/operators on Windows or macOS bringing up or flying the cockpit, plus contributors debugging panel↔sim behaviour. Single-user desktop app, no accounts.

## 4. Background — what it must speak (grounded in firmware)

**The relay (what `socat` did)** — `Firmware/ScratchPad/Arduino_Tools/connect-serial-port.cmd`:

- DCS-BIOS **export** in: UDP multicast `239.255.50.10:5010`.
- DCS-BIOS **command/import** out: UDP `localhost:7778` (TCP `127.0.0.1:7778` fallback).
- Serial: SimGateway COM port, nominally 250000 8N1, DTR off (USB-CDC ignores baud — it is virtual).
- Transparent + bidirectional: export bytes → serial; serial bytes → 7778.

**SimGateway USB = composite device** (`Firmware/Libraries/SimGateway/SimGateway.cpp`, VID/PID at `:287`):

- **CDC interface** — the DCS-BIOS byte stream both ways (relay loop `:311`). This is the serial side SkyHawkClient owns. The CDC carries the DCS-BIOS export (binary) upstream and ASCII commands downstream; it does **not** carry HID (HID `0xAA 0x55` frames are demuxed off the UART and never written to CDC).
- **HID interface** — a separate joystick the OS claims. Report struct (`SimGateway.cpp:17-21`): `uint8_t buttons[16]` (128×1-bit) + `uint8_t hats[2]` (4×4-bit nibbles) + `int16_t axes[8]` = **34 bytes**, no report ID. Axes 0-7 = Roll/Pitch/Throttle/Rudder/BrakeL/BrakeR/Zoom/spare; hats 0 = centred,1=N…8=NW; buttons bit-packed (button n → byte n/8, bit n%8).

**Aircraft + decode reference:** `tools/gen_a4ec/data/A-4E-C.jsonp` is the committed DCS-BIOS A-4E-C control reference (313 outputs / 150 inputs, names match DCS-BIOS/Bort) — the source the firmware's `Firmware/Libraries/A4EC/*` headers are generated from. HID control names: `Firmware/Libraries/HIDControls/HIDControls.h` (axes `0x0010-1F`, hats `0x0020-2F`, buttons `0x0030-AF`). No `_ACFT_NAME` in-repo — the live aircraft name lives in DCS-BIOS **common metadata** (a stable cross-module address), so the app bundles that address; absent it, infers "A-4E-C" from observed `0x8400-0x8554` traffic.

**Remote / cross-machine DCS — SimGateway here, DCS elsewhere (the primary remote scenario):** DCS-BIOS is pure UDP, but its default **export multicast `239.255.50.10:5010` is bound to loopback (127.0.0.1)** — it does **not** reach another machine unless `BIOSConfig.lua` is edited to send a **unicast** copy to this app's IP. The robust remote path is instead a **TCP connection to `<DCS-host>:7778`, which is bidirectional** (receive export _and_ send commands over one socket — the `.cmd`'s TCP fallback already proves this against `127.0.0.1`; point it at the DCS PC's IP for remote).

**Confirmed against the local DCS-BIOS v0.11.2 `BIOSConfig.lua`** (`Firmware/ScratchPad/DCS-BIOS/.../BIOSConfig.lua`): `tcp_config = {{ address = "*", port = 7778 }}` and `udp_config = {{ receive_address = "*", receive_port = 7778, send_address = "239.255.50.10", send_port = 5010 }}`. So **port 7778 binds all interfaces** (TCP server _and_ UDP command receiver) — a remote machine reaches it with **no host-side script**; the only host requirement is opening the **Windows firewall for inbound TCP 7778**. Only the export _multicast_ (`send_address = 239.255.50.10`) is loopback, hence TCP is the clean remote transport; a UDP-only alternative is the one-line `send_address = "<this-app-IP>"` edit (still no running script). So: SimGateway in the Mac → app TCP-connects to `192.168.85.25:7778` → relays both ways to the SimGateway serial. In **Monitor mode** the same applies minus the serial; HID needs a local USB device, so it is simply absent on a remote-only test box. A `BIOSConfig.lua` reader (`dcsbios-config.ts`) is a convenience — auto-fill host/ports + warn — not a requirement for the TCP path.

**USB enumeration / interface identity:** the composite SimGateway presents the OS **two interfaces under one device** ("A-4E Skyhawk", VID `0x2E8A`/PID `0x4134`) — a **CDC serial port** (COMx / `/dev/cu.usbmodem*`) and a **HID joystick**. The app picks the serial port by VID/PID + CDC class. Firmware follow-up (§12): give the CDC its own **interface string descriptor** (TinyUSB `iInterface`) so the port advertises a friendly name like the HID product string already does.

## 5. Architecture

Electron two-process split; all Node-native I/O (serial, HID, UDP) in **main**, UI in **renderer**, typed IPC between.

**Three source modes + Record** (the parser / log / aircraft / stats / telemetry path is identical — only the transport differs, so the rest of the app is source-agnostic):

- **Bridge** (full): SimGateway serial ↔ DCS-BIOS live, plus HID. DCS may be **local** (loopback multicast/UDP) or **remote** (TCP-connect `<DCS-host>:7778`, or `BIOSConfig.lua` unicast). Replaces `socat`/the `.cmd`.
- **Monitor** (no device): DCS-BIOS live (local or remote), no serial, HID disabled. Inspect/test only.
- **Replay** (no DCS): feed the parser/UI from a recorded capture file; optionally also write the replayed export to a connected SimGateway serial to drive the real cockpit with no DCS running.
- **Record** (any live mode): capture the raw DCS-BIOS stream (+ timestamps) to a file for later replay / bug reports.

Settings expose: source mode, DCS host + transport (`loopback-multicast | unicast-listen | tcp-to-host`), command port, capture/replay file. A single `Transport` interface is fed by `dcsbios-net.ts` (live) or `replay.ts` (file); the parser + relay consume it without caring which.

**Main process (`src/main/`)**

- `bridge/serial.ts` — `node-serialport`: enumerate ports, match VID/PID `0x2E8A/0x4134` + CDC class to pick the SimGateway port, open, read/write raw bytes, auto-reconnect on unplug. (Two-interface identity: §4.)
- `bridge/dcsbios-net.ts` — the live DCS-BIOS transport: loopback multicast `239.255.50.10:5010` (export in) / UDP `7778` (commands out), **or TCP-connect `<DCS-host>:7778`** (bidirectional — remote DCS), or a unicast listen port. Drives the byte-for-byte relay in Bridge mode (export→serial, serial→DCS).
- `bridge/replay.ts` — record the raw stream (+ timing) to a capture file; replay a capture as a synthetic export source into the parser/relay (optionally out to the serial). Reuses the firmware repo's `dcsbios_data.json` capture shape where practical.
- `bridge/dcsbios-config.ts` — discovery: read the user's `…/Saved Games/DCS*/Scripts/DCS-BIOS/BIOSConfig.lua` to learn configured export/command addresses; warn when a remote setup needs an edit.
- `bridge/dcsbios-parser.ts` — decode the DCS-BIOS export protocol (sync frame → address/value words) for the log/telemetry; the parser is a **tap** — parsing never gates the relay (relay forwards raw bytes regardless).
- `bridge/hid.ts` — `node-hid`: open the same composite device's HID interface in parallel (shared read; DCS keeps using it as a joystick), poll the 34-byte report, decode axes/buttons/hats.
- `reference/` — the **vendored, generated** TS modules (see §7): A-4E-C address→{name,mask,type,range}, HID controlId→name, HID report layout, DCS-BIOS common-metadata address.
- `stats.ts` — counters: throughput each way, frame rate, command rate/total/last, errors/resyncs, uptime, reconnects; selected telemetry values.

**Renderer (`src/renderer/`)** — React + TS dashboard panels (§6), state via a light store (Zustand or context), fed by IPC events (throttled/batched ~30 Hz so the log can't flood React).

**IPC contract (`src/shared/`)** — typed channels: `device:status`, `aircraft:changed`, `stats:tick`, `log:batch`, `hid:report`, plus `control:setPort` / `control:pauseLog` / `log:export`.

## 6. Functional requirements (UI panels)

1. **Connection** — auto-detected device (name/VID/PID/port), state (scanning / connected / relaying / error / reconnecting), DCS link (transport, **local vs remote host**, UDP/TCP, multicast joined / `7778` reachable), source-mode + remote-DCS host picker, manual port override, **record / replay** controls, start/stop. Auto-reconnect on unplug.
2. **Aircraft** — live module name from DCS-BIOS common metadata `_ACFT_NAME` (address `0x0000`, string[24], value or `"NONE"`); else inferred "A-4E-C (from address range)"; else "no aircraft / sim not exporting". **Non-A-4E module → amber warning banner** ("named decode is A-4E-C only — relaying + stats continue; log shows raw addresses").
3. **Stats** (chosen scope = health + command activity + sim telemetry):
   - _Link/stream health_: bytes/sec each direction, DCS-BIOS frames/sec, parse/resync errors, uptime, reconnect count.
   - _Command activity_: panel→sim commands/sec, total, last command string.
   - _Sim telemetry_: live decoded readouts — **RPM, IAS, Flap, Pressure Altitude, Fuel** (A-4E-C output addresses; render "—" if not exported) — surfaced as gauges; the set is configurable later.
4. **Live log** — decoded rows `time · dir · control name · value` (names from the bundled A-4E-C map), with **filter+search** (name/address/direction), **pause+autoscroll+clear**, **export session to file**, **raw↔decoded toggle** (hex/ASCII vs name+value).
5. **HID status** — all 8 axes (bar + signed value), 128 buttons (lit grid, named where HIDControls.h names them), 4 hats (direction indicator); report rate; "idle (no recent report)" state since reports are on-change.

## 7. Firmware sync (build-script, copies from the OpenSkyhawk repo)

A committed `scripts/sync-a4ec.ts` (run via `npm run sync`, and as a `prebuild` step) **sparse-fetches a pinned git commit** of the OpenSkyhawk repo and emits typed modules under `src/main/reference/`:

- `tools/gen_a4ec/data/A-4E-C.jsonp` → `a4ec-controls.generated.ts` (address→{name,mask,type,range,description}; both decode-by-address and command lookup).
- `Firmware/Libraries/HIDControls/HIDControls.h` → `hid-controls.generated.ts` (controlId→name, range sentinels).
- SimGateway HID report layout (`Firmware/Libraries/SimGateway/SimGateway.cpp:17-21`) → `hid-report-layout.generated.ts` (byte offsets/counts) — parsed or asserted against a checked-in expectation so a firmware change fails the sync loudly.
- DCS-BIOS common metadata (`Firmware/ScratchPad/DCS-BIOS/.../doc/json/MetadataStart.json`) → `_ACFT_NAME` at address `0x0000` (string[24]) + version/export-rate → bundled constants.

Generated files are committed (offline builds, like Bort), regenerated on demand. Header banner records source commit + timestamp. This is the "reference to the existing implementation" — loose coupling, no submodule, standalone build.

## 8. Tech stack & tooling

Electron, TypeScript, React, Vite (or electron-forge + Vite) for build; `node-serialport`, `node-hid`, Node `dgram`/`net` for UDP/TCP; Zustand for state; Vitest + ESLint + Prettier; electron-builder packaging. **License GPL-2.0-only** (matches the firmware; Bort GPL-3 is a _pattern_ reference only — no code copied). App identity: **"OpenSkyhawk Client"**, bundle id `com.openskyhawk.client`, reusing the OpenSkyhawk emblem + docs-site dark theme.

**Pre-commit:** Husky + lint-staged — run ESLint + Prettier + `tsc --noEmit` on staged files (`.husky/pre-commit`).

**CI — `.github/workflows/ci.yml`** (PR + push to main): install → `npm run sync` freshness check → lint → typecheck → **unit tests (Vitest) — a required gate** (on `ubuntu-latest` for speed, since tests are pure TS) + a build smoke job on `windows-latest` + `macos-latest` to catch native-module/build breaks. Parser, A-4E-C decode, HID-report decode, and replay must ship with unit tests.

**Release — `.github/workflows/release.yml`** (on `v*` tag): matrix `windows-latest` + `macos-latest`, build Electron artifacts (electron-builder) and attach to a GitHub Release. **Unsigned for now** — code-signing + auto-update stay deferred (§2).

## 9. Repo layout (SkyHawkClient)

```
SkyHawkClient/
├── PRD.md                      ← this document (committed first)
├── .husky/pre-commit           ← lint-staged: eslint + prettier + tsc --noEmit
├── .github/workflows/
│   ├── ci.yml                  ← PR/push: sync-check, lint, typecheck, vitest (+ win/mac build smoke)
│   └── release.yml             ← tag v*: build Win + Mac Electron artifacts → GitHub Release
├── src/main/{bridge,reference,stats}.ts ...
├── src/renderer/{panels,store}/ ...
├── src/shared/ipc.ts
├── scripts/sync-a4ec.ts        ← firmware sync (also a CI step / prebuild)
├── package.json  electron.vite.config.ts  tsconfig.json  .eslintrc  .prettierrc
└── README.md (data-flow + how it relates to the firmware repo)
```

## 10. Milestones (Lean MVP)

1. **Scaffold** — Electron+TS+React+Vite skeleton, IPC contract, GPL header, PRD.md + README committed; Husky/lint-staged pre-commit + `ci.yml` (lint/typecheck/Vitest) green from commit one.
2. **Sync script** — `sync-a4ec.ts` generating the reference modules from a local OpenSkyhawk checkout; commit the generated output.
3. **DCS-BIOS net + parser + log — Network monitor mode (no hardware)** — `dcsbios-net.ts` (multicast/unicast in, `<host>:7778` out) → parser → decoded log (all four log features) + aircraft detection (name→infer) + stream-health/command/telemetry stats + Connection panel. **Testable immediately Mac↔Windows-DCS with no SimGateway** — the primary test path; ship/verify this slice first.
4. **Serial bridge + remote DCS (parity)** — port enumerate/auto-detect + the relay so the same parser/UI drives real hardware; add **remote-DCS TCP-connect** (`<host>:7778`) + `BIOSConfig.lua` discovery for SimGateway-here / DCS-elsewhere. Verify against the `.cmd` on Win + Mac.
5. **HID** — node-hid read + decode, HID status panel; sim-telemetry readouts.
6. **Record + Replay** — capture to file in any live mode; replay a capture into the parser/UI (and optionally the serial) with no DCS. Unlocks the no-DCS dev/test loop.
7. **Package + release** — unsigned `npm run build` artifacts for Win + Mac; `release.yml` builds them on a `v*` tag and attaches to a GitHub Release. Defer signing/auto-update/tray.

## 11. Verification

- **Relay parity:** with DCS + DCS-BIOS running, SkyHawkClient (no socat) drives the real cockpit exactly as `connect-serial-port.cmd` did — gauges/LEDs update, panel switches reach DCS. Cross-check on Win and Mac. Also verify the **remote** variant: SimGateway on the Mac, DCS on a Windows PC, app TCP-connected to `<DCS-IP>:7778`.
- **Record + Replay (no DCS):** record a live A-4E-C session, then replay it → log/aircraft/stats reproduce, and (optionally) the replayed export drives the real cockpit with DCS closed; assert decoded names/values match the A-4E-C map. Also ingest the firmware repo's `dcsbios_data.json` captures.
- **Split-machine DCS-BIOS (the headline test mode):** app on macOS in **Network monitor** mode, DCS on a Windows PC on the same LAN; load A-4E-C → aircraft name + decoded log + stats + telemetry populate from the live UDP stream with **no SimGateway attached** (HID panel shows "no device"). Verify both multicast and unicast-fallback export configs, and that a command sent from the Mac reaches DCS (`<DCS-host>:7778`).
- **HID:** move a stick axis / press a mapped button → the HID panel reflects it, while DCS still reads the joystick (parallel read works on both OSes).
- **Aircraft:** load A-4E-C → name resolves; load another module → graceful name/inference.
- **Sync:** change a name in the firmware `A-4E-C.jsonp`, run `npm run sync`, log labels update; a HID-layout change makes the sync assertion fail loudly.

## 12. Decisions (all resolved — ready to build)

- **DCS-BIOS `7778` bind:** binds **all interfaces** (`tcp_config.address="*"`, `udp_config.receive_address="*"`, DCS-BIOS v0.11.2). Remote = **TCP-connect `<host>:7778`**, **no host-side script**, Windows firewall (inbound TCP 7778) only. Local default = loopback multicast; UDP-unicast (`send_address` edit) optional. `dcsbios-config.ts` (reads `BIOSConfig.lua`) is convenience auto-fill, not required.
- **`_ACFT_NAME`:** address **`0x0000`**, null-terminated string, max 24 bytes (`MetadataStart.json`) — read for the live module name; sync bundles the DCS-BIOS common metadata.
- **Sim-telemetry default readouts:** **RPM, IAS, Flap position, Pressure Altitude, Fuel quantity** (mapped to A-4E-C output addresses; render "—" if an address isn't exported). Everything else stays in the log.
- **Sync source:** **pinned git URL + commit** of the OpenSkyhawk repo — `sync-a4ec.ts` sparse-fetches the pinned ref; generated files stay committed so normal builds need no network; CI's sync-check re-fetches the pin to confirm freshness.
- **Replay format:** **superset of `dcsbios_data.json`** — adds direction/aircraft/session metadata, still loadable by the firmware repo's logger/replayer.
- **License:** **GPL-2.0-only**, same as the OpenSkyhawk firmware (`Firmware/LICENSE`, `HIDControls.h`). _Caveat:_ Bort is GPL-3.0 — reference its pattern only, never copy its source (GPL-2-only is incompatible with GPL-3 code).
- **App identity:** display name **"OpenSkyhawk Client"**, bundle id `com.openskyhawk.client`.
- **Branding:** reuse the transparent OPEN SKYHAWK emblem + the docs-site dark aerospace theme.

**Firmware follow-ups — file tracking issues in the OpenSkyhawk repo (confirmed):**

- Add a **CDC interface string descriptor** (TinyUSB `iInterface`) to the SimGateway USB config so the serial port advertises a friendly name like the HID product string already does.
- **Report connected PanelGroup nodes** (CAN node discovery/heartbeat → PanelBridge → SimGateway → client) to enable a future "Connected nodes" panel. Not MVP.
