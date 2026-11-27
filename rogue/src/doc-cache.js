// @ts-check
//
// IndexedDB-backed per-doc op log. This is the *client-side doc cache*: every
// op the client merges (server-streamed or its own) is appended, so a reload
// can replay the log into a fresh CRDT and resume without re-downloading the
// full history — and a previously-opened doc reads offline.
//
// One row per op, and everything the sync client needs is derived from it:
//
//   • `since`       per replica, the max cached seq. `seq` is a Lamport clock,
//                   so this is a maximum, not a coverage count — gaps are by
//                   design and a contiguous floor can never pass the first one,
//                   which re-streamed the replica on every connect (0.4.x).
//   • `acked`       the server has this op. Remote ops arrive acked; own ops
//                   start unacked and are marked by the ack. `own && !acked` is
//                   the send queue, so "what may I skip" and "what must I
//                   resend" stop being the same number.
//   • `rejected`    a hint that this engine cannot render the op, per engine
//                   version. Never a deletion: the row is the only copy of the
//                   author's text.
//
// Key is `[docId, seq, replica]` (composite), which sorts naturally into the
// CRDT's canonical (seq, replica) order for replay. `put` on the same key is
// an idempotent overwrite, so re-caching an op is a no-op and duplicates are
// impossible. See docs/plan-sync-model.md in the server repo.

import * as nodeIdV0 from '@pointyink/serde/node_id_v0'

const DB_NAME = 'rogue-doc-cache'
const DB_VERSION = 3
const STORE = 'ops'
const CONFIRMED = 'confirmed'

// Rejections live in their own database, on purpose. Adding a store to the cache
// DB means *requesting an upgrade*, and an upgrade waits — in some browsers
// without ever firing `blocked` — while any other tab still holds a connection.
// That is a production outage, not a theoretical one: 0.4.1 bumped the cache and
// every cache call in a second tab timed out. A brand-new database has no older
// connection to wait for, so this one can never wedge.
const REJECTED_DB = 'rogue-doc-rejected'
const REJECTED = 'rejected'

// Bump when the HTML validator or the recovery policy changes. A rejected op is
// a claim about *this* engine ("I cannot render it"), not about the document, so
// a new engine must be allowed to look again — a stricter-then-fixed validator
// should not keep an op hidden for ever. Stored with each row and compared on
// read; stale rows are simply ignored.
export const REJECT_VERSION = '0.6.1'

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null
/** @type {Promise<IDBDatabase> | null} */
let rejectedDbPromise = null

/** @param {IDBDatabase} db */
function closeOnVersionChange(db) {
  db.onversionchange = () => db.close()
}

/**
 * Open a database **without requesting a version**, creating the schema only when
 * there is none. A versionless open never waits on another connection; the only
 * upgrading open is the one that creates a brand-new database, which by
 * definition has no other connection to wait for.
 * @param {string} name
 * @param {string} store
 * @param {number} version
 * @param {(db: IDBDatabase) => void} create
 * @returns {Promise<IDBDatabase>}
 */
function openExisting(name, store, version, create) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name)
    req.onerror = () => reject(req.error ?? new Error(`${name} open failed`))
    req.onsuccess = () => {
      const db = req.result
      if (db.objectStoreNames.contains(store)) {
        closeOnVersionChange(db)
        resolve(db)
        return
      }
      // No schema yet. If the database is *empty* — the versionless open just
      // created it at v1 — it has to be removed first: opening at `version` would
      // be a no-op upgrade (1 === 1) and never fire `onupgradeneeded`.
      const empty = db.objectStoreNames.length === 0
      db.close()
      recreate(empty).then(resolve, reject)
    }

    /** @param {boolean} empty @returns {Promise<IDBDatabase>} */
    async function recreate(empty) {
      if (empty) {
        await new Promise((done) => {
          const del = indexedDB.deleteDatabase(name)
          del.onsuccess = del.onerror = del.onblocked = () => done(undefined)
        })
      }
      return new Promise((res, rej) => {
        const up = indexedDB.open(name, version)
        up.onupgradeneeded = () => create(up.result)
        up.onerror = () => rej(up.error ?? new Error(`${name} create failed`))
        up.onsuccess = () => {
          closeOnVersionChange(up.result)
          res(up.result)
        }
      })
    }
  })
}

function openDB() {
  if (dbPromise) return dbPromise
  const p = openExisting(DB_NAME, STORE, DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(STORE)) {
      db.createObjectStore(STORE, { keyPath: ['docId', 'seq', 'replica'] })
    }
    if (!db.objectStoreNames.contains(CONFIRMED)) {
      db.createObjectStore(CONFIRMED, { keyPath: ['docId', 'replica'] })
    }
  })
  // Cache the in-flight open: every cache call goes through here (one per op, per
  // ack, per keystroke), so an uncached open leaks a connection per call.
  dbPromise = p
  p.catch(() => {
    if (dbPromise === p) dbPromise = null
  })
  return p
}

function openRejectedDB() {
  if (rejectedDbPromise) return rejectedDbPromise
  const p = openExisting(REJECTED_DB, REJECTED, 1, (db) => {
    if (!db.objectStoreNames.contains(REJECTED)) {
      db.createObjectStore(REJECTED, { keyPath: ['docId', 'gid'] })
    }
  })
  rejectedDbPromise = p
  p.catch(() => {
    if (rejectedDbPromise === p) rejectedDbPromise = null
  })
  return p
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
      // A remote op came from the server, so the server has it. An own op is
      // unconfirmed until its ack (or until the server sends it back to us).
      acked: opts.own !== true,
    })
    tx.oncomplete = () => resolve(undefined)
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * The highest cached seq per replica — the `since` a client should ask from.
 * `seq` is a Lamport clock with gaps, so this is a maximum, not a coverage
 * count. Re-derived on every load, so it can never claim an op that is not here.
 * @param {string} docId
 * @returns {Promise<Record<string, number>>}
 */
export async function maxSeqPerReplica(docId) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const range = IDBKeyRange.bound([docId], [docId, []])
    const req = tx.objectStore(STORE).getAllKeys(range)
    req.onsuccess = () => {
      /** @type {Record<string, number>} */
      const out = {}
      for (const key of /** @type {any[]} */ (req.result) || []) {
        const seq = Number(key[1])
        const replica = String(key[2])
        if (!(replica in out) || seq > out[replica]) out[replica] = seq
      }
      resolve(out)
    }
    req.onerror = () => reject(req.error)
  })
}

/**
 * How many cached ops this doc has per replica — the client's half of the
 * server's `sync_counts` report. A server count above this one means an op never
 * arrived, which `since` (a per-replica maximum) cannot show.
 * @param {string} docId
 * @returns {Promise<Record<string, number>>}
 */
export async function countPerReplica(docId) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const range = IDBKeyRange.bound([docId], [docId, []])
    const req = tx.objectStore(STORE).getAllKeys(range)
    req.onsuccess = () => {
      /** @type {Record<string, number>} */
      const out = {}
      for (const key of /** @type {any[]} */ (req.result) || []) {
        const replica = String(key[2])
        out[replica] = (out[replica] ?? 0) + 1
      }
      resolve(out)
    }
    req.onerror = () => reject(req.error)
  })
}

/**
 * Every cached op for a doc, with its provenance, in canonical (seq, replica)
 * order — the order to replay into a fresh CRDT.
 * @param {string} docId
 * @returns {Promise<Array<{ payload: Uint8Array, own: boolean, acked: boolean }>>}
 */
export async function cachedRows(docId) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const range = IDBKeyRange.bound([docId], [docId, []])
    const req = tx.objectStore(STORE).getAll(range)
    req.onsuccess = () => {
      const items = /** @type {any[]} */ (req.result) || []
      resolve(
        items.map((it) => ({
          payload: it.payload,
          own: it.own === true,
          // Rows written before 0.5.0 have no `acked`. A remote row was stored by
          // the server by definition; an *own* row might be the cache-only
          // orphan this flag exists to find, so default it to unacked — a
          // duplicate send is idempotent, a stranded op is lost content.
          acked: it.acked === undefined ? it.own !== true : it.acked === true,
        })),
      )
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
 * Mark rows as confirmed by the server (an ack, or the server sending them back).
 * Idempotent; rows that are already acked are rewritten harmlessly.
 * @param {string} docId
 * @param {Array<{ replica: number, seq: number }>} ids
 * @returns {Promise<void>}
 */
export async function markAcked(docId, ids) {
  if (ids.length === 0) return
  const db = await openDB()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const { replica, seq } of ids) {
      const req = store.get([docId, seq, replica])
      req.onsuccess = () => {
        const row = req.result
        if (row && row.acked !== true) store.put({ ...row, acked: true })
      }
    }
    tx.oncomplete = () => resolve(undefined)
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * The stored payloads for a set of `"replica:seq"` keys. The skip set needs them:
 * a skipped op has to be mergeable *after* the fact when the document turns out
 * not to validate without it.
 * @param {string} docId
 * @param {string[]} gids
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function cachedPayloads(docId, gids) {
  /** @type {Map<string, Uint8Array>} */
  const out = new Map()
  if (gids.length === 0) return out
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    for (const gid of gids) {
      const [replica, seq] = String(gid).split(':').map(Number)
      const req = store.get([docId, seq, replica])
      req.onsuccess = () => {
        if (req.result) out.set(String(gid), req.result.payload)
      }
      req.onerror = () => {}
    }
    tx.oncomplete = () => resolve(out)
    tx.onerror = () => reject(tx.error)
  })
}

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
export async function rejectedGids(docId, at = {}) {
  const version = at.version ?? REJECT_VERSION
  const db = await openRejectedDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REJECTED, 'readonly')
    const range = IDBKeyRange.bound([docId], [docId, []])
    const req = tx.objectStore(REJECTED).getAll(range)
    req.onsuccess = () => {
      const out = []
      for (const row of /** @type {any[]} */ (req.result) || []) {
        if (row.version !== version) continue
        out.push(String(row.gid))
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
 * @param {{ version?: string }} [at]
 */
export async function addRejectedGid(docId, gid, at = {}) {
  const db = await openRejectedDB()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(REJECTED, 'readwrite')
    tx.objectStore(REJECTED).put({ docId, gid, version: at.version ?? REJECT_VERSION })
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
  const range = () => IDBKeyRange.bound([docId], [docId, []])

  const db = await openDB()
  const stores = [STORE, CONFIRMED].filter((s) => db.objectStoreNames.contains(s))
  await new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite')
    for (const store of stores) tx.objectStore(store).delete(range())
    tx.oncomplete = () => resolve(undefined)
    tx.onerror = () => reject(tx.error)
  })

  // The rejected set lives in its own database; a doc delete clears both.
  try {
    const rdb = await openRejectedDB()
    await new Promise((resolve, reject) => {
      const tx = rdb.transaction(REJECTED, 'readwrite')
      tx.objectStore(REJECTED).delete(range())
      tx.oncomplete = () => resolve(undefined)
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    /* the verdict store is optional: nothing to clear if it can't be opened */
  }
}
