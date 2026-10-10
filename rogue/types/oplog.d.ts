/**
 * Add an op to the pending queue. Called before the op is sent over the wire.
 * IndexedDB stores the Uint8Array via the structured-clone algorithm — no
 * encoding wrapper needed; survives reload as the original bytes.
 * @param {string} docId
 * @param {string} id      group NodeId "r:s"
 * @param {Uint8Array} payload multi_op_v0 binary as emitted by the CRDT
 */
export function enqueue(docId: string, id: string, payload: Uint8Array): Promise<void>;
/**
 * Drop a batch of ids in one transaction. Missing ids are no-ops.
 * @param {string} docId
 * @param {string[]} ids
 */
export function ackMany(docId: string, ids: string[]): Promise<void>;
/**
 * Drop a doc's pending ops (e.g. on doc delete) so they're never re-sent.
 * @param {string} docId
 */
export function clearDoc(docId: string): Promise<void>;
/**
 * Return all unacked ops for a doc, oldest first.
 * Uses a range query on the compound key prefix — `[]` upper bound sorts
 * above any primitive, so this matches every `[docId, *]` entry.
 * @param {string} docId
 * @returns {Promise<{id: string, payload: Uint8Array, ts: number}[]>}
 */
export function pendingFor(docId: string): Promise<{
    id: string;
    payload: Uint8Array;
    ts: number;
}[]>;
