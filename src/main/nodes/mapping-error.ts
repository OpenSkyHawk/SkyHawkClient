// The refusal a node-mapping change answers with (pure). Its own file so the rules that refuse — the
// mapping's (mapping-rules.ts) and the adopt gate's (node-kind.ts requireAdoptable) — share it
// without importing each other.

/** Thrown for input the UI should have prevented; main turns it into an error result. */
export class MappingError extends Error {}
