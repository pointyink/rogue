/**
 * Advance a per-replica watermark with an op's group node id (the first 6 bytes
 * are node_id_v0). Mutates and returns `wm`.
 * @param {Record<string, number>} wm
 * @param {Uint8Array} payload
 * @returns {Record<string, number>}
 */
export function advanceWatermark(wm: Record<string, number>, payload: Uint8Array): Record<string, number>;
/**
 * Merge an op, then advance the watermark — only on success. If `mergeOp`
 * throws, the watermark is untouched, so the op is re-fetched next sync.
 * @param {(payload: Uint8Array) => void} mergeOp
 * @param {Record<string, number>} wm
 * @param {Uint8Array} payload
 * @returns {Record<string, number>}
 */
export function mergeAndAdvance(mergeOp: (payload: Uint8Array) => void, wm: Record<string, number>, payload: Uint8Array): Record<string, number>;
/**
 * Append the watermark as a `since` query param. Empty watermark → unchanged.
 * @param {string} wsUrl
 * @param {Record<string, number>} wm
 * @returns {string}
 */
export function appendSince(wsUrl: string, wm: Record<string, number>): string;
