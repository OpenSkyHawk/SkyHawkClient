# Agent instructions

Rules for agents working in this repo. For where code lives and which way it may depend, see
[ARCHITECTURE.md](./ARCHITECTURE.md). For what the app does and why, see [PRD.md](./PRD.md).

The firmware lives in [OpenSkyHawk/OpenSkyhawk](https://github.com/OpenSkyHawk/OpenSkyhawk).
This repo is the client.

## Release facts

Never say a firmware feature is "in firmware vX" without checking the tag. In the OpenSkyhawk
repo:

```bash
git merge-base --is-ancestor <commit> firmware-vX
```

Exit code 0 means the commit is in that release; anything else means it is not.

- Firmware before 1.0.0 is test-only. 1.0.0 is the first public release.
- Why: the `firmware-v0.2.0` tag was cut 7 minutes before OpenSkyhawk#359 merged, so "from
  firmware v0.2.0" in #169 and #171 was wrong.

## Minimum firmware

A client PR that depends on a firmware change names the firmware commit or release it needs, in
the PR body. Check it with the command above before writing a release name.

## No magic numbers

Every address, code, enum and layout value comes from `npm run sync` (generated, imported from
`@shared/firmware`), never a literal. If the sync does not extract something yet, extend
`scripts/sync-a4ec.ts` and run `npm run sync`; do not type the value by hand. Example:
`NODE_FORGET_REQ_ADDR` (#188).

DCS-BIOS `_ACFT_NAME` is not a firmware value: it is a DCS-BIOS protocol value read from the DCS
stream, so the sync does not carry it. See
[Firmware values come from `npm run sync`](./ARCHITECTURE.md#firmware-values-come-from-npm-run-sync).

`SUPPORTED_FIRMWARE_MAJOR` is not a firmware value either: it is the client's own claim of the
major its parser is written for (D22), so this rule does not apply to it.

## Ticket closure

Before a ticket closes, tick each box with its evidence ("— #PR") or move it to a named
follow-up ticket. Never close a ticket with boxes unticked.

## Firmware claims get a review

Any ticket text that states firmware behaviour, wire format or release facts goes to the
firmware (OpenSkyhawk) session for review before it reaches the user.
