# OpenSkyhawk Client

Cross-platform (Windows + macOS) desktop app that connects the **OpenSkyhawk** A-4E
home cockpit to DCS — replacing the console-only `connect-serial-port.cmd` / `socat`
relay with a single GUI that **is the bridge and the monitor**.

It auto-detects the SimGateway, relays the DCS-BIOS stream both ways, and shows the
connection, the loaded aircraft, live stats, a decoded DCS-BIOS log, and full per-element
HID status. See **[PRD.md](./PRD.md)** for the full design.

> Status: **early scaffold** (Milestone 1). Wiring up over the milestones in the PRD.

## How it fits the OpenSkyhawk stack

```
DCS  ──DCS-BIOS (UDP/TCP)──  OpenSkyhawk Client  ──USB CDC serial──  SimGateway ── UART ── PanelBridge ── CAN ── PanelGroups
                                   │                                   └ HID joystick ─────────────────────────────────┘
                                   └ reads the HID interface too (axes/buttons/hats)
```

- **Bridge** mode: SimGateway serial ↔ DCS-BIOS (local, or **remote** DCS via `TCP <host>:7778`).
- **Monitor** mode: DCS-BIOS off the LAN, no device — inspect/test from any machine.
- **Replay** mode: feed a recorded capture, no DCS needed.

This repo is standalone. Protocol constants (A-4E-C control map, HID layout, `_ACFT_NAME`
address) are **generated** from a pinned commit of the [OpenSkyhawk firmware
repo](https://github.com/OpenSkyHawk/OpenSkyhawk) via `npm run sync` — see PRD §7.

## Develop

```bash
npm install      # Node 24+
npm run dev      # launch the app (electron-vite)
npm test         # vitest unit tests
npm run lint
npm run build    # typecheck + bundle
```

## Remote DCS (SimGateway here, DCS on another PC)

DCS-BIOS binds port **7778 on all interfaces** by default, so the client connects over the
LAN with **no script on the DCS host** — just open the Windows firewall for inbound TCP 7778
and point the client at `tcp://<DCS-IP>:7778`. (The export multicast `239.255.50.10:5010` is
loopback-only, hence TCP is the remote transport.) See PRD §4.

## License

Copyright (c) 2026 OpenSkyHawk.

**GPL-2.0-only** — see [LICENSE](./LICENSE) (verbatim GPL v2 text). Matches DCS-BIOS (GPL v2),
whose control-reference data the client bundles. Note: GPL permits commercial use; it cannot be
made non-commercial.
