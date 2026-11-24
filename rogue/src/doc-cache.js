// @ts-check
//
// IndexedDB-backed per-doc op log. This is the *client-side doc cache*: every
// op the client merges (server-streamed or its own) is appended, so a reload
// can replay the log into a fresh CRDT and resume without re-downloading the
// full history — and a previously-opened doc reads offline.
//
// It also stores the **confirmed floor**: for each replica, the highest seq n
// such that this client is sure the server holds *every* op 1..n. That is what
// `since` is built from, and it is deliberately not derived from the cache:
// the cache says "I applied it", which is not the same as "the server has it"
// (an op can be cached and still never sent). Advancing `since` over a cached
// op the server never received hides it for ever.
//
// So the floor only moves **after** the thing it claims is durable:
//   • an op streamed from the server → after its cache write commits;
//   • an op we authored → only when its ack arrives (the ack means "stored").
// Both live in this DB, so losing one loses the other; a stale floor can cause
// a re-download, never a skipped op.
//
// Key is `[docId, seq, replica]` (composite), which sorts naturally into the
// CRDT's canonical (seq, replica) order for replay. `put` on the same key is
// an idempotent overwrite, so re-caching an op is a no-op and duplicates are
// impossible.
//
// The floor advances by exactly one: a hole freezes it, which is the point —
// the next sync asks for the hole instead of skipping past it. Out-of-order
// acks are therefore ignored rather than buffered; the server re-sends
// everything above the floor, so the ledger heals itself at the cost of one
// re-download. Over-fetching is the safe direction.

import * as nodeIdV0 from '@pointyink/serde/node_id_v0'

const DB_NAME = 'rogue-doc-cache'
const DB_VERSION = 3
const STORE = 'ops'
const CONFIRMED = 'confirmed'
const REJECTED = 'rejected'

// Bump when the HTML validator or the recovery policy changes. A rejected op is
// a claim about *this* engine ("I cannot render it"), not about the document, so
// a new engine must be allowed to look again — a stricter-then-fixed validator
// should not keep an op hidden for ever. Stored with each row and compared on
// read; stale rows are simply ignored.
const REJECT_VERSION = '0.4.1'

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
      if (!db.objectStoreNames.contains(CONFIRMED)) {
        db.createObjectStore(CONFIRMED, { keyPath: ['docId', 'replica'] })
      }
      if (!db.objectStoreNames.contains(REJECTED)) {
        db.createObjectStore(REJECTED, { keyPath: ['docId', 'gid'] })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

/**
 * @param {Uint8Array} payload
 * @returns {{ replica: number, seq: number } | null}
 */
function idOf(payload) {
  if (payload.byteLength < nodeIdV0.SIZE) return null
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const id = nodeIdV0.decode(view, 0)
  return { replica: id.replica_id, seq: id.sequence }
}

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
export async function cacheOp(docId, payload, opts = {}) {
  const id = idOf(payload)
  if (!id) return
  const db = await openDB()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({
      docId,
      seq: id.seq,
      replica: id.replica,
      payload,
      own: opts.own === true,
    })
    tx.oncomplete = () => resolve(undefined)
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * Every cached op for a doc, with its provenance, in canonical (seq, replica)
 * order — the order to replay into a fresh CRDT.
 * @param {string} docId
 * @returns {Promise<Array<{ payload: Uint8Array, own: boolean }>>}
 */
export async function cachedRows(docId) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const range = IDBKeyRange.bound([docId], [docId, []])
    const req = tx.objectStore(STORE).getAll(range)
    req.onsuccess = () => {
      const items = /** @type {any[]} */ (req.result) || []
      resolve(items.map((it) => ({ payload: it.payload, own: it.own === true })))
    }
    req.onerror = () => reject(req.error)
  })
}

/**
 * Return every cached op for a doc, in canonical (seq, replica) order — the
 * order to replay into a fresh CRDT. Prefer `cachedRows` when provenance
 * matters.
 * @param {string} docId
 * @returns {Promise<Uint8Array[]>}
 */
export async function cachedOps(docId) {
  const rows = await cachedRows(docId)
  return rows.map((r) => r.payload)
}

/**
 * @param {string} docId
 * @returns {Promise<Record<string, number>>} replica id → confirmed floor
 */
export async function confirmedFloors(docId) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIRMED, 'readonly')
    const range = IDBKeyRange.bound([docId], [docId, []])
    const req = tx.objectStore(CONFIRMED).getAll(range)
    req.onsuccess = () => {
      /** @type {Record<string, number>} */
      const out = {}
      for (const row of /** @type {any[]} */ (req.result) || []) {
        out[String(row.replica)] = row.seq
      }
      resolve(out)
    }
    req.onerror = () => reject(req.error)
  })
}

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
export async function raiseConfirmed(docId, replica, seq) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIRMED, 'readwrite')
    const store = tx.objectStore(CONFIRMED)
    let floor = 0
    const req = store.get([docId, replica])
    req.onsuccess = () => {
      floor = Number(req.result?.seq) || 0
      if (seq === floor + 1) {
        store.put({ docId, replica, seq })
        floor = seq
      }
    }
    tx.oncomplete = () => resolve(floor)
    tx.onerror = () => reject(tx.error)
  })
}

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
export async function setConfirmed(docId, replica, seq) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIRMED, 'readwrite')
    const store = tx.objectStore(CONFIRMED)
    let floor = 0
    const req = store.get([docId, replica])
    req.onsuccess = () => {
      floor = Number(req.result?.seq) || 0
      if (seq > floor) {
        store.put({ docId, replica, seq })
        floor = seq
      }
    }
    tx.oncomplete = () => resolve(floor)
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * Ops this engine has decided it cannot render, as `"replica:seq"` keys.
 *
 * A load that walks back, or an op rejected on apply, is a permanent verdict for
 * *this* engine version but not necessarily for the next one, so the version
 * travels with the verdict and a mismatch is ignored (the op is retried).
 * @param {string} docId
 * @param {string} [version]
 * @returns {Promise<string[]>}
 */
export async function rejectedGids(docId, version = REJECT_VERSION) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REJECTED, 'readonly')
    const range = IDBKeyRange.bound([docId], [docId, []])
    const req = tx.objectStore(REJECTED).getAll(range)
    req.onsuccess = () => {
      const out = []
      for (const row of /** @type {any[]} */ (req.result) || []) {
        if (row.version === version) out.push(String(row.gid))
      }
      resolve(out)
    }
    req.onerror = () => reject(req.error)
  })
}

/**
 * Remember that this engine cannot render an op, so the next load does not pay
 * the walk-back again. Idempotent.
 * @param {string} docId
 * @param {string} gid `"replica:seq"`
 * @param {string} [version]
 */
export async function addRejectedGid(docId, gid, version = REJECT_VERSION) {
  const db = await openDB()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(REJECTED, 'readwrite')
    tx.objectStore(REJECTED).put({ docId, gid, version })
    tx.oncomplete = () => resolve(undefined)
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * Drop a doc's cached history, its confirmed floor and its rejected set (e.g. on
 * doc delete).
 * They go together: a floor without the history would skip ops on the next
 * sync, and the history without the floor only costs a re-download.
 * @param {string} docId
 */
export async function clearDoc(docId) {
  const db = await openDB()
  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, CONFIRMED, REJECTED], 'readwrite')
    const range = IDBKeyRange.bound([docId], [docId, []])
    tx.objectStore(STORE).delete(range)
    tx.objectStore(CONFIRMED).delete(range)
    tx.objectStore(REJECTED).delete(range)
    tx.oncomplete = () => resolve(undefined)
    tx.onerror = () => reject(tx.error)
  })
}
