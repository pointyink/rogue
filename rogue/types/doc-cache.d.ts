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
 * Every cached op for a doc, with its provenance, in canonical (seq, replica)
 * order — the order to replay into a fresh CRDT.
 * @param {string} docId
 * @returns {Promise<Array<{ payload: Uint8Array, own: boolean }>>}
 */
export function cachedRows(docId: string): Promise<Array<{
    payload: Uint8Array;
    own: boolean;
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
 * @param {string} docId
 * @returns {Promise<Record<string, number>>} replica id → confirmed floor
 */
export function confirmedFloors(docId: string): Promise<Record<string, number>>;
/**
 * Advance a replica's confirmed floor by one, if this seq is the next one.
 *
 * The read and the write are one transaction, so concurrent callers cannot
 * both see the same floor and leapfrog. A seq that is not exactly `floor + 1`
 * is ignored: either it is already covered, or there is a hole below it — and
 * the whole point is that a hole must not be stepped over.
 * @param {string} docId
 * @param {number} replica
 * @param {number} seq
 * @returns {Promise<number>} the floor after the attempt
 */
export function raiseConfirmed(docId: string, replica: number, seq: number): Promise<number>;
/**
 * Force a replica's confirmed floor, past a hole that two full replays could
 * not fill. This is the one place the floor may skip a seq: the op is
 * genuinely gone from the server, and continuing to ask for it would re-download
 * the replica's whole tail on every connect, for ever. Monotonic — never moves
 * backwards.
 * @param {string} docId
 * @param {number} replica
 * @param {number} seq
 * @returns {Promise<number>} the floor after the write
 */
export function setConfirmed(docId: string, replica: number, seq: number): Promise<number>;
/**
 * How many ops this doc has cached. Cheap enough to read on every load; used to
 * tell "nothing has changed since this verdict" from "the document grew".
 * @param {string} docId
 * @returns {Promise<number>}
 */
export function cachedOpsCount(docId: string): Promise<number>;
/**
 * Ops this engine has decided it cannot render, as `"replica:seq"` keys.
 *
 * A load that walks back, or an op rejected on apply, is a permanent verdict for
 * *this* engine version but not necessarily for the next one, so the version
 * travels with the verdict and a mismatch is ignored (the op is retried).
 *
 * A verdict is also keyed by the number of cached ops it was formed against. A
 * walk-back rejection is *context-dependent* — the engine's contract is that an
 * op invalid at its own prefix may be valid once later ops arrive (see
 * docs/plan-load-walkback.md) — so a document that has grown since the verdict
 * must be re-examined, not skipped. That matters: a paste whose opening and
 * closing tags arrive in different sessions would otherwise stay truncated.
 *
 * Keyed by gid alone, so a doc deleted and re-created with the same id while
 * this client was offline would inherit a stale verdict. `clearDoc` drops them
 * on an observed deletion; the offline-recreate window is the only gap.
 * @param {string} docId
 * @param {{ count?: number, version?: string }} [at] the cache size the verdict
 *   applies to; omit to read regardless of size
 * @returns {Promise<string[]>}
 */
export function rejectedGids(docId: string, at?: {
    count?: number;
    version?: string;
}): Promise<string[]>;
/**
 * Remember that this engine cannot render an op, so the next load does not pay
 * the walk-back again. Idempotent.
 * @param {string} docId
 * @param {string} gid `"replica:seq"`
 * @param {{ count?: number, version?: string }} [at] the cache size the verdict
 *   was formed against
 */
export function addRejectedGid(docId: string, gid: string, at?: {
    count?: number;
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
