/**
 * Firmware sync — generates `src/main/reference/*.generated.ts` from a PINNED
 * commit of the OpenSkyhawk firmware repo. See PRD.md §7 / §12.
 *
 * Sources (sparse-fetched from the pinned commit):
 *   tools/gen_a4ec/data/A-4E-C.jsonp                -> a4ec-controls.generated.ts
 *   Firmware/Libraries/HIDControls/HIDControls.h    -> hid-controls.generated.ts
 *   Firmware/Libraries/SimGateway/SimGateway.cpp    -> hid-report-layout.generated.ts (asserted)
 *   Firmware/ScratchPad/DCS-BIOS/.../MetadataStart.json -> metadata.generated.ts (_ACFT_NAME @ 0x0000)
 *
 * TODO(M2): implement the sparse-fetch + codegen. Until then this is a no-op so
 * `npm run sync` and the CI freshness gate stay green.
 */

const PINNED = {
  repo: 'git@github.com:OpenSkyHawk/OpenSkyhawk.git',
  commit: '' // set when codegen lands in M2
}

function main(): void {
  console.log(
    `[sync-a4ec] stub — codegen lands in M2 (source ${PINNED.repo}@${PINNED.commit || 'unpinned'}). Nothing generated.`
  )
}

main()
