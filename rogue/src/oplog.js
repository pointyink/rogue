// @ts-check
//
// IndexedDB-backed queue of ops that have been emitted but not yet
// hard-acked by the server. Persists across page reloads so we never lose
// in-flight work. The CRDT's op_index makes apply idempotent, so replaying
// an op the server already received is safe.
//
// Primary key is `[docId, id]` (composite). Replica IDs are 16-bit random
// and short docs have low sequence numbers, so cross-doc id collisions are
// realistic — scoping the key by docId keeps them isolated.

const DB_NAME = 'rogue-oplog'
const DB_VERSION = 1
const STORE = 'pending_ops'

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null

function openDB() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        // Composite primary key: prefix-queries on docId work via range bounds,
        // no secondary index needed.
        db.createObjectStore(STORE, { keyPath: ['docId', 'id'] })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

/**
 * Add an op to the pending queue. Called before the op is sent over the wire.
 * IndexedDB stores the Uint8Array via the structured-clone algorithm — no
 * encoding wrapper needed; survives reload as the original bytes.
 * @param {string} docId
 * @param {string} id      group NodeId "r:s"
 * @param {Uint8Array} payload multi_op_v0 binary as emitted by the CRDT
 */
export async function enqueue(docId, id, payload) {
  const db = await openDB()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({ docId, id, payload, ts: Date.now() })
    tx.oncomplete = () => resolve(undefined)
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * Drop a batch of ids in one transaction. Missing ids are no-ops.
 * @param {string} docId
 * @param {string[]} ids
 */
export async function ackMany(docId, ids) {
  if (ids.length === 0) return
  const db = await openDB()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const id of ids) store.delete([docId, id])
    tx.oncomplete = () => resolve(undefined)
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * Drop a doc's pending ops (e.g. on doc delete) so they're never re-sent.
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

/**
 * Count the doc's unacked ops without materializing them. Cheaper than
 * `pendingFor(docId).length` for a recovery panel polling "N ops not sent".
 * @param {string} docId
 * @returns {Promise<number>}
 */
export async function pendingCount(docId) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const range = IDBKeyRange.bound([docId], [docId, []])
    const req = tx.objectStore(STORE).count(range)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/**
 * Return all unacked ops for a doc, oldest first.
 * Uses a range query on the compound key prefix — `[]` upper bound sorts
 * above any primitive, so this matches every `[docId, *]` entry.
 * @param {string} docId
 * @returns {Promise<{id: string, payload: Uint8Array, ts: number}[]>}
 */
export async function pendingFor(docId) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const range = IDBKeyRange.bound([docId], [docId, []])
    const req = tx.objectStore(STORE).getAll(range)
    req.onsuccess = () => {
      const items = /** @type {any[]} */ (req.result) || []
      items.sort((a, b) => a.ts - b.ts)
      resolve(items)
    }
    req.onerror = () => reject(req.error)
  })
}
