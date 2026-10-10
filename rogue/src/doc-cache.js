// @ts-check
//
// IndexedDB-backed per-doc op log. This is the *client-side doc cache*: every
// op the client merges (server-streamed or its own) is appended, so a reload
// can replay the log into a fresh CRDT and resume without re-downloading the
// full history — and a previously-opened doc reads offline.
//
// Unlike the oplog (which holds only *unacked* ops), this log is the full
// merged history. It's also what makes the sync checkpoint safe to derive on
// reload: the per-replica watermark is rebuilt from the ops actually present
// here, so it can never claim an op the client doesn't actually hold.
//
// Key is `[docId, seq, replica]` (composite), which sorts naturally into the
// CRDT's canonical (seq, replica) order for replay. `put` on the same key is
// an idempotent overwrite, so re-caching an op is a no-op and duplicates are
// impossible.

import * as nodeIdV0 from '@pointyink/serde/node_id_v0'

const DB_NAME = 'rogue-doc-cache'
const DB_VERSION = 1
const STORE = 'ops'

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null

function openDB() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: ['docId', 'seq', 'replica'] })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

/**
 * Append an op to the doc's cached history. Keyed by (replica, seq) from the
 * op's group node id, so re-caching is an idempotent no-op. The op is stored
 * as raw multi_op_v0 bytes (structured-cloned, survives reload unchanged).
 * @param {string} docId
 * @param {Uint8Array} payload multi_op_v0 binary as emitted by the CRDT
 */
export async function cacheOp(docId, payload) {
  if (payload.byteLength < nodeIdV0.SIZE) return
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const id = nodeIdV0.decode(view, 0)
  const db = await openDB()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({ docId, seq: id.sequence, replica: id.replica_id, payload })
    tx.oncomplete = () => resolve(undefined)
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * Return every cached op for a doc, in canonical (seq, replica) order — the
 * order to replay into a fresh CRDT. Missing/partial logs are fine: the
 * watermark is derived from exactly these ops, so the server sends the gap.
 * @param {string} docId
 * @returns {Promise<Uint8Array[]>}
 */
export async function cachedOps(docId) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const range = IDBKeyRange.bound([docId], [docId, []])
    const req = tx.objectStore(STORE).getAll(range)
    req.onsuccess = () => {
      const items = /** @type {any[]} */ (req.result) || []
      resolve(items.map((it) => it.payload))
    }
    req.onerror = () => reject(req.error)
  })
}

/**
 * Drop a doc's cached history (e.g. on doc delete).
 * @param {string} docId
 */
export async function clearDoc(docId) {
  const db = await openDB()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(IDBKeyRange.bound([docId], [docId, []]))
    tx.oncomplete = () => resolve(undefined)
    tx.onerror = () => reject(tx.error)
  })
}
