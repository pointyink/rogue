/**
 * Advance a per-replica watermark with an op's group node id (the first 6 bytes
 * are node_id_v0). Mutates and returns `wm`.
 * @param {Record<string, number>} wm
 * @param {Uint8Array} payload
 * @returns {Record<string, number>}
 */
export function advanceWatermark(wm: Record<string, number>, payload: Uint8Array): Record<string, number>;
/**
 * Merge an op, then advance the watermark — only when it actually applied.
 *
 * The engine parks an op whose parent hasn't arrived (it does not throw), and a
 * parked op is *not* applied: advancing over it would tell the next sync we have
 * it, `since` would skip it, and it would stay invisible for ever. So 'parked'
 * and 'deferred' leave the watermark alone and the op is re-fetched.
 * @param {(payload: Uint8Array) => (string | void)} mergeOp
 * @param {Record<string, number>} wm
 * @param {Uint8Array} payload
 * @returns {Record<string, number>}
 */
export function mergeAndAdvance(mergeOp: (payload: Uint8Array) => (string | void), wm: Record<string, number>, payload: Uint8Array): Record<string, number>;
/**
 * Append the watermark as a `since` query param. Empty watermark → unchanged.
 *
 * `omit` names replicas whose history is known to be incomplete (a merge failed
 * for one of their ops). `since` is a per-replica seq floor, so it cannot ask
 * for one specific missing op — leaving the replica out makes the server replay
 * it in full, and merges are idempotent, so over-fetching is safe. Without this,
 * a later op from the same replica raises the floor past the hole and the
 * missing parent can never arrive.
 * @param {string} wsUrl
 * @param {Record<string, number>} wm
 * @param {Set<string>} [omit]
 * @returns {string}
 */
export function appendSince(wsUrl: string, wm: Record<string, number>, omit?: Set<string>): string;
