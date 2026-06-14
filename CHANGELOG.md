# Changelog

## [0.1.0] (2026-06-14)

### Features

- **bridge:** M4 — SimGateway serial bridge + remote DCS parity ([#6](https://github.com/OpenSkyHawk/SkyHawkClient/pull/6))
- **debug:** developer debug logging + serial-port dump ([#13](https://github.com/OpenSkyHawk/SkyHawkClient/pull/13))
- **hid:** M5 — live HID status + wire-format decode fix ([#7](https://github.com/OpenSkyHawk/SkyHawkClient/pull/7))
- **monitor:** M3 — DCS-BIOS network monitor (parser, transport, live UI) ([#5](https://github.com/OpenSkyHawk/SkyHawkClient/pull/5))
- **nodes:** connected PanelGroup nodes in Connection ([#15](https://github.com/OpenSkyHawk/SkyHawkClient/pull/15)) ([#16](https://github.com/OpenSkyHawk/SkyHawkClient/pull/16))
- **nodes:** panel names + keep offline nodes (red) ([#22](https://github.com/OpenSkyHawk/SkyHawkClient/pull/22))
- **replay:** M6 — record + replay DCS-BIOS sessions ([#8](https://github.com/OpenSkyHawk/SkyHawkClient/pull/8))
- **replay:** optionally drive the SimGateway serial from a capture ([#12](https://github.com/OpenSkyHawk/SkyHawkClient/pull/12))
- **serial:** live raw serial monitor (TX/RX hex + ASCII) ([#21](https://github.com/OpenSkyHawk/SkyHawkClient/pull/21))
- **settings:** persist config across restarts ([#9](https://github.com/OpenSkyHawk/SkyHawkClient/pull/9))
- **sync:** M2 — generate A-4E-C / HID reference modules from pinned firmware
- **ui:** drop light-theme switch from Settings (not implemented)
- **ui:** honest idle state, %-FS telemetry, HID availability dimming ([#10](https://github.com/OpenSkyHawk/SkyHawkClient/pull/10))
- **ui:** port Claude Design mockup to React (5 tabs + design system)
- **ui:** tabbed shell with logo home screen
- **ui:** toggle relay by clicking the status pill ([#23](https://github.com/OpenSkyHawk/SkyHawkClient/pull/23))

### Bug Fixes

- **connection:** device identity reflects actual connection ([#19](https://github.com/OpenSkyHawk/SkyHawkClient/pull/19))
- **log:** 1000-row cap; route errors + node msgs to debug.log ([#20](https://github.com/OpenSkyHawk/SkyHawkClient/pull/20))
- **log:** duplicate rows from double IPC subscription ([#17](https://github.com/OpenSkyHawk/SkyHawkClient/pull/17))
- **log:** rehydrate session state, log errors, Clear + Export ([#18](https://github.com/OpenSkyHawk/SkyHawkClient/pull/18))
- **setup:** fetch Electron binary via postinstall (Node 24)

### Build & Packaging

- packaging — icon, asarUnpack native modules, unsigned installers ([#11](https://github.com/OpenSkyHawk/SkyHawkClient/pull/11))
