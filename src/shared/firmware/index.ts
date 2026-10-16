// Hand-written barrel over the firmware reference that `npm run sync` (scripts/sync-a4ec.ts)
// generates from a pinned OpenSkyhawk commit. This is the only import path: import from
// '@shared/firmware' (or './firmware' inside src/shared), never from a *.generated.ts file.
//
// A leaf: nothing in this folder imports anything else in src (L-firmware-leaf).
export * from './a4ec-controls.generated'
export * from './axis-cal.generated'
export * from './hid-controls.generated'
export * from './hid-report-layout.generated'
export * from './node-names.generated'
export * from './node-status.generated'
