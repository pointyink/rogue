// @ts-check
//
// The regression that took production down: a cache database created by an
// older build (v2, no `rejected` store) must keep working, and opening it must
// never wait on another connection. Requesting an upgrade is what hangs — in
// some browsers forever, without even firing `blocked` — so the open is
// versionless and the schema is only created for a database that has none.
//
// Its own file: the module caches the open, so it needs a fresh instance, and
// this file must create the v2 database *before* importing it.
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'

/** @param {number} replica @param {number} seq */
function opPayload(replica, seq) {
  const out = new Uint8Array(10)
  const view = new DataView(out.buffer)
  view.setUint16(0, replica, true)
  view.setUint32(2, seq, true)
  return out
}

/** A v2 cache database, as 0.4.0 left it: `ops` + `confirmed`, no `rejected`. */
async function makeV2WithOneOp() {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('rogue-doc-cache', 2)
    req.onupgradeneeded = () => {
      const d = req.result
      if (!d.objectStoreNames.contains('ops')) {
        d.createObjectStore('ops', { keyPath: ['docId', 'seq', 'replica'] })
      }
      if (!d.objectStoreNames.contains('confirmed')) {
        d.createObjectStore('confirmed', { keyPath: ['docId', 'replica'] })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const op = opPayload(1, 1)
  await new Promise((resolve, reject) => {
    const tx = (/** @type {IDBDatabase} */ (db)).transaction('ops', 'readwrite')
    tx.objectStore('ops').put({ docId: 'old', seq: 1, replica: 1, payload: op, own: false })
    tx.oncomplete = () => resolve(undefined)
    tx.onerror = () => reject(tx.error)
  })
  return { db, op }
}

describe('doc-cache upgrade path', () => {
  it('uses an existing v2 database as-is, even with another connection open', async () => {
    const { db, op } = await makeV2WithOneOp()
    try {
      const { cachedRows, rejectedGids } = await import('./doc-cache.js')

      // The v2 connection above is still open. Opening at a higher version here
      // is exactly what hung production; this must resolve.
      const rows = await cachedRows('old')
      expect(rows).toHaveLength(1)
      expect(Array.from(rows[0].payload)).toEqual(Array.from(op))

      // Rejections live in their own database, so a v2 cache still gets them.
      expect(await rejectedGids('old')).toEqual([])

      // And the cache was not silently upgraded out from under the old tab.
      const version = await new Promise((resolve) => {
        const req = indexedDB.open('rogue-doc-cache')
        req.onsuccess = () => {
          resolve(req.result.version)
          req.result.close()
        }
      })
      expect(version).toBe(2)
    } finally {
      ;(/** @type {IDBDatabase} */ (db)).close()
    }
  })
})
