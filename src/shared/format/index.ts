// Format helpers main, shared and the renderer print with: one copy of each. This barrel is the
// only import path: import from '@shared/format' (or './format' inside src/shared), never from a
// module file.
//
// A leaf: nothing in this folder imports anything else in src (L-format-leaf), so a helper that
// needs a contract type, a model rule or a firmware table stays with that owner.
export * from './events'
export * from './file-errors'
export * from './psu'
export * from './text'
export * from './time'
export * from './units'
