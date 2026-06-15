# Changelog

## [0.2.0](https://github.com/OpenSkyHawk/SkyHawkClient/compare/openskyhawk-client-v0.1.0...openskyhawk-client-v0.2.0) (2026-06-15)


### Features

* **bridge:** M4 — SimGateway serial bridge + remote DCS parity ([#6](https://github.com/OpenSkyHawk/SkyHawkClient/issues/6)) ([aed3e36](https://github.com/OpenSkyHawk/SkyHawkClient/commit/aed3e36dc3c9623b9255febd4c021c26d2658925))
* **debug:** developer debug logging + serial-port dump ([#13](https://github.com/OpenSkyHawk/SkyHawkClient/issues/13)) ([5412067](https://github.com/OpenSkyHawk/SkyHawkClient/commit/54120672572b1163c98b228c5da54df8883caf6f))
* **hid:** M5 — live HID status + wire-format decode fix ([#7](https://github.com/OpenSkyHawk/SkyHawkClient/issues/7)) ([ceb4ac0](https://github.com/OpenSkyHawk/SkyHawkClient/commit/ceb4ac09c5ec422d50a256102372519c00322e4f))
* **monitor:** M3 — DCS-BIOS network monitor (parser, transport, live UI) ([#5](https://github.com/OpenSkyHawk/SkyHawkClient/issues/5)) ([5e4ee41](https://github.com/OpenSkyHawk/SkyHawkClient/commit/5e4ee413d525731650d93da150473aef94425efc))
* **nodes:** connected PanelGroup nodes in Connection ([#15](https://github.com/OpenSkyHawk/SkyHawkClient/issues/15)) ([#16](https://github.com/OpenSkyHawk/SkyHawkClient/issues/16)) ([1eaa367](https://github.com/OpenSkyHawk/SkyHawkClient/commit/1eaa36724f476f5ee53ae8c32af1f5499c46c71d))
* **nodes:** panel names + keep offline nodes (red) ([#22](https://github.com/OpenSkyHawk/SkyHawkClient/issues/22)) ([3ca3a10](https://github.com/OpenSkyHawk/SkyHawkClient/commit/3ca3a1018c2e92c6eecbd65f97d88bc88ce57bcb))
* **replay:** M6 — record + replay DCS-BIOS sessions ([#8](https://github.com/OpenSkyHawk/SkyHawkClient/issues/8)) ([2bf5b34](https://github.com/OpenSkyHawk/SkyHawkClient/commit/2bf5b34722f8e254f9dc28deab278e5dbeb57dbe))
* **replay:** optionally drive the SimGateway serial from a capture ([#12](https://github.com/OpenSkyHawk/SkyHawkClient/issues/12)) ([10891ee](https://github.com/OpenSkyHawk/SkyHawkClient/commit/10891eefd9fe514e4175659714127ef98de74914))
* **serial:** live raw serial monitor (TX/RX hex + ASCII) ([#21](https://github.com/OpenSkyHawk/SkyHawkClient/issues/21)) ([bc39e66](https://github.com/OpenSkyHawk/SkyHawkClient/commit/bc39e66621ece3c151811bb1c42c241f1de66773))
* **settings:** persist config across restarts ([#9](https://github.com/OpenSkyHawk/SkyHawkClient/issues/9)) ([8b10064](https://github.com/OpenSkyHawk/SkyHawkClient/commit/8b10064dac069b7fa5f3545e71f59cbd489202c3))
* **sync:** M2 — generate A-4E-C / HID reference modules from pinned firmware ([f5fe3a2](https://github.com/OpenSkyHawk/SkyHawkClient/commit/f5fe3a204d2a370166004eebe073c6ba6cfe9d41))
* **sync:** M2 — generate A-4E-C / HID reference modules from pinned firmware ([0c3d97f](https://github.com/OpenSkyHawk/SkyHawkClient/commit/0c3d97ff3b2baff79461f8f4bccb7256fa6c7fb4))
* **ui:** drop light-theme switch from Settings (not implemented) ([05ab19d](https://github.com/OpenSkyHawk/SkyHawkClient/commit/05ab19d56dd328430ff611b663114fdad0c2c24c))
* **ui:** honest idle state, %-FS telemetry, HID availability dimming ([#10](https://github.com/OpenSkyHawk/SkyHawkClient/issues/10)) ([bb246cc](https://github.com/OpenSkyHawk/SkyHawkClient/commit/bb246cc7f564026c4cc3a27231a411ec19a8d40c))
* **ui:** port Claude Design mockup — 5-tab dashboard + design system ([53df725](https://github.com/OpenSkyHawk/SkyHawkClient/commit/53df7250704cd0024fdecc61adb927b35737130a))
* **ui:** port Claude Design mockup to React (5 tabs + design system) ([d6d6f68](https://github.com/OpenSkyHawk/SkyHawkClient/commit/d6d6f684c012842af43d389785d2aa6bbb137059))
* **ui:** tabbed shell with logo home screen ([28e67c4](https://github.com/OpenSkyHawk/SkyHawkClient/commit/28e67c485b0e96102d8aa6d8287f51efdc403e2f))
* **ui:** toggle relay by clicking the status pill ([#23](https://github.com/OpenSkyHawk/SkyHawkClient/issues/23)) ([ccd2048](https://github.com/OpenSkyHawk/SkyHawkClient/commit/ccd204809b6a962d739b8b75859655f2ec485de7))


### Bug Fixes

* **connection:** device identity reflects actual connection ([#4](https://github.com/OpenSkyHawk/SkyHawkClient/issues/4)) ([#19](https://github.com/OpenSkyHawk/SkyHawkClient/issues/19)) ([fb854c0](https://github.com/OpenSkyHawk/SkyHawkClient/commit/fb854c0c8515e66e7419c73cb4cef3f8a920dec5))
* **log:** 1000-row cap; route errors + node msgs to debug.log ([#20](https://github.com/OpenSkyHawk/SkyHawkClient/issues/20)) ([4cf8d56](https://github.com/OpenSkyHawk/SkyHawkClient/commit/4cf8d5637ac924911cfd82431589769926fb6b4e))
* **log:** duplicate rows from double IPC subscription ([#17](https://github.com/OpenSkyHawk/SkyHawkClient/issues/17)) ([a20cfc0](https://github.com/OpenSkyHawk/SkyHawkClient/commit/a20cfc0cb67a8d220704d1375a079f5597a09f95))
* **log:** rehydrate session state, log errors, Clear + Export ([#18](https://github.com/OpenSkyHawk/SkyHawkClient/issues/18)) ([d51ee92](https://github.com/OpenSkyHawk/SkyHawkClient/commit/d51ee924c5ca215baa73a3f358af88f8ef2e63d3))
* **setup:** fetch Electron binary via postinstall (Node 24) ([3de637c](https://github.com/OpenSkyHawk/SkyHawkClient/commit/3de637c634b29b2aa22b85207f298184575f10e8))


### Build & Packaging

* **m7:** packaging — icon, asarUnpack native modules, unsigned installers ([#11](https://github.com/OpenSkyHawk/SkyHawkClient/issues/11)) ([80115c9](https://github.com/OpenSkyHawk/SkyHawkClient/commit/80115c9cf9d34dc3393ac8294a8af46290213831))

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
