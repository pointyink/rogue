// @ts-check
//
// Cross-language error contract with the WASM (rogue/crdt/wasm.zig `ErrorKind`).
// The int `type` is the stable machine key (discriminator semantics — never
// reorder or reuse a value); `name` is the human-facing @tagName. Kept in sync
// with wasm.zig via the shared fixture (rogue/crdt/error_kinds.json) and the
// conformance test (crdt_error.test.js) — a mismatch fails CI.

/** @type {{ readonly [name: string]: number }} */
export const CrdtErrorKind = Object.freeze({
  out_of_memory: 1,
  invalid_group: 2,
  out_of_bounds: 3,
  parse_error: 4,
  render_overflow: 5,
  unknown_parent: 6,
  unknown_target: 7,
  unknown_id: 8,
})

/** Reverse map: type int → human name, for logging. @type {Record<number, string>} */
export const CrdtErrorNames = Object.freeze(
  Object.fromEntries(Object.entries(CrdtErrorKind).map(([name, type]) => [type, name])),
)

/**
 * @typedef {{ type: number, name: string, desc?: string }} CrdtError
 */

/**
 * Parse the structured error payload the WASM wrote into out_buf on a failed
 * call (`{"type":N,"name":"...","desc":"..."}`). Returns null if it can't be
 * parsed — treat that as an unknown error.
 * @param {string} payload
 * @returns {CrdtError | null}
 */
export function parseCrdtError(payload) {
  try {
    const parsed = JSON.parse(payload)
    if (typeof parsed?.type !== 'number' || typeof parsed?.name !== 'string') return null
    return { type: parsed.type, name: parsed.name, desc: parsed.desc }
  } catch {
    return null
  }
}
