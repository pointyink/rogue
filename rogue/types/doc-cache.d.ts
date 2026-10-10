/**
 * Append an op to the doc's cached history. Keyed by (replica, seq) from the
 * op's group node id, so re-caching is an idempotent no-op. The op is stored
 * as raw multi_op_v0 bytes (structured-cloned, survives reload unchanged).
 * @param {string} docId
 * @param {Uint8Array} payload multi_op_v0 binary as emitted by the CRDT
 */
export function cacheOp(docId: string, payload: Uint8Array): Promise<void>;
/**
 * Return every cached op for a doc, in canonical (seq, replica) order — the
 * order to replay into a fresh CRDT. Missing/partial logs are fine: the
 * watermark is derived from exactly these ops, so the server sends the gap.
 * @param {string} docId
 * @returns {Promise<Uint8Array[]>}
 */
export function cachedOps(docId: string): Promise<Uint8Array[]>;
/**
 * Drop a doc's cached history (e.g. on doc delete).
 * @param {string} docId
 */
export function clearDoc(docId: string): Promise<void>;
