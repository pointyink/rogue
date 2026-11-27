/**
 * Append an op to the doc's cached history. Keyed by (replica, seq) from the
 * op's group node id, so re-caching is an idempotent no-op. The op is stored
 * as raw multi_op_v0 bytes (structured-cloned, survives reload unchanged).
 *
 * `own` marks an op this client authored, so bootstrap can tell which cached
 * ops it may have to re-send (see `cachedRows`).
 * @param {string} docId
 * @param {Uint8Array} payload multi_op_v0 binary as emitted by the CRDT
 * @param {{ own?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export function cacheOp(docId: string, payload: Uint8Array, opts?: {
    own?: boolean;
}): Promise<void>;
/**
 * The highest cached seq per replica — the `since` a client should ask from.
 * `seq` is a Lamport clock with gaps, so this is a maximum, not a coverage
 * count. Re-derived on every load, so it can never claim an op that is not here.
 * @param {string} docId
 * @returns {Promise<Record<string, number>>}
 */
export function maxSeqPerReplica(docId: string): Promise<Record<string, number>>;
/**
 * How many cached ops this doc has per replica — the client's half of the
 * server's `sync_counts` report. A server count above this one means an op never
 * arrived, which `since` (a per-replica maximum) cannot show.
 * @param {string} docId
 * @returns {Promise<Record<string, number>>}
 */
export function countPerReplica(docId: string): Promise<Record<string, number>>;
/**
 * Every cached op for a doc, with its provenance, in canonical (seq, replica)
 * order — the order to replay into a fresh CRDT.
 * @param {string} docId
 * @returns {Promise<Array<{ payload: Uint8Array, own: boolean, acked: boolean }>>}
 */
export function cachedRows(docId: string): Promise<Array<{
    payload: Uint8Array;
    own: boolean;
    acked: boolean;
}>>;
/**
 * Return every cached op for a doc, in canonical (seq, replica) order — the
 * order to replay into a fresh CRDT. Prefer `cachedRows` when provenance
 * matters.
 * @param {string} docId
 * @returns {Promise<Uint8Array[]>}
 */
export function cachedOps(docId: string): Promise<Uint8Array[]>;
/**
 * Mark rows as confirmed by the server (an ack, or the server sending them back).
 * Idempotent; rows that are already acked are rewritten harmlessly.
 * @param {string} docId
 * @param {Array<{ replica: number, seq: number }>} ids
 * @returns {Promise<void>}
 */
export function markAcked(docId: string, ids: Array<{
    replica: number;
    seq: number;
}>): Promise<void>;
/**
 * The stored payloads for a set of `"replica:seq"` keys. The skip set needs them:
 * a skipped op has to be mergeable *after* the fact when the document turns out
 * not to validate without it.
 * @param {string} docId
 * @param {string[]} gids
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export function cachedPayloads(docId: string, gids: string[]): Promise<Map<string, Uint8Array>>;
/**
 * Ops this engine has decided it cannot render, as `"replica:seq"` keys.
 *
 * A load that walks back, or an op rejected on apply, is a permanent verdict for
 * *this* engine version but not necessarily for the next one, so the version
 * travels with the verdict and a mismatch is ignored (the op is retried).
 *
 * A verdict is **not** keyed by the cache size. It was, to catch a rejection that
 * only held for a particular prefix (an op invalid alone but valid once later
 * ops arrive — see docs/plan-load-walkback.md), but the size is read while the
 * last cache writes are still in flight, so the recorded number is routinely a
 * few short. The next load then sees a "changed" document, ignores the verdict,
 * walks back, and records another slightly-wrong number: it never converges, and
 * the document pays the walk-back on every load. Correctness is not at stake —
 * a stale verdict can only hide an op that would now render — and re-examining
 * is a separate, cheap job once the document is up, not a reason to skip the
 * fast path for ever.
 *
 * Keyed by gid alone, so a doc deleted and re-created with the same id while
 * this client was offline would inherit a stale verdict. `clearDoc` drops them
 * on an observed deletion; the offline-recreate window is the only gap.
 * @param {string} docId
 * @param {{ version?: string }} [at]
 * @returns {Promise<string[]>}
 */
export function rejectedGids(docId: string, at?: {
    version?: string;
}): Promise<string[]>;
/**
 * Remember that this engine cannot render an op, so the next load does not pay
 * the walk-back again. Idempotent.
 * @param {string} docId
 * @param {string} gid `"replica:seq"`
 * @param {{ version?: string }} [at]
 */
export function addRejectedGid(docId: string, gid: string, at?: {
    version?: string;
}): Promise<void>;
/**
 * Drop a doc's cached history, its confirmed floor and its rejected set (e.g. on
 * doc delete).
 * They go together: a floor without the history would skip ops on the next
 * sync, and the history without the floor only costs a re-download.
 * @param {string} docId
 */
export function clearDoc(docId: string): Promise<void>;
export const REJECT_VERSION: "0.4.3";
