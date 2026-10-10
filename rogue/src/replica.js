// @ts-check
//
// Stable, collision-free replica ids. The `replica` half of a CRDT node id
// `(replica, seq)` must be stable per writer and unique within a doc. The
// server allocates ids from 2 (1 is reserved for the offline doc creator), and
// the client persists the result per-doc so a reload keeps the same id. See
// docs/plan-replica-ids.md.

const REPLICA_ID_PREFIX = 'rogue.replicaId.'

/**
 * Derive the sync host's HTTPS origin from a ws(s) URL like
 * `wss://sync.example.com/ws/<docId>`.
 * @param {string} wsUrl
 * @returns {string}
 */
export function syncBaseUrlFromWsUrl(wsUrl) {
  const u = new URL(wsUrl)
  return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`
}

/**
 * Read the persisted replica id for a doc, or null if absent/invalid.
 * @param {string} docId
 * @returns {number | null}
 */
export function persistedReplicaId(docId) {
  const raw = localStorage.getItem(REPLICA_ID_PREFIX + docId)
  if (raw === null) return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= 65534 ? n : null
}

/**
 * @param {string} docId
 * @param {number} id
 */
function persistReplicaId(docId, id) {
  localStorage.setItem(REPLICA_ID_PREFIX + docId, String(id))
}

/**
 * Resolve the replica id to use for a doc.
 *
 *  1. A read-only peer (readOnly) never writes, so it returns an unused random
 *     id without any server round-trip — `/docs/{id}/replica` requires write
 *     perm and would 403 a viewer.
 *  2. A persisted id (per-doc, localStorage) wins — stable across reloads.
 *  3. A brand-new doc (isNewDoc) uses 1: the client minted the uuid, so it's
 *     the only writer and 1 is collision-free — no server round-trip, works
 *     offline.
 *  4. Otherwise ask the server to allocate a fresh id.
 *
 * @param {{
 *   docId: string,
 *   wsUrl: string,
 *   getToken: () => Promise<string>,
 *   isNewDoc?: boolean,
 *   readOnly?: boolean,
 * }} opts
 * @returns {Promise<number>}
 */
export async function resolveReplicaId({ docId, wsUrl, getToken, isNewDoc = false, readOnly = false }) {
  if (readOnly) {
    return Math.floor(Math.random() * 65534) + 1
  }

  const persisted = persistedReplicaId(docId)
  if (persisted !== null) return persisted

  if (isNewDoc) {
    persistReplicaId(docId, 1)
    return 1
  }

  const token = await getToken()
  const res = await fetch(`${syncBaseUrlFromWsUrl(wsUrl)}/docs/${docId}/replica`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`replica allocation failed: ${res.status}`)
  const { replica_id } = await res.json()
  persistReplicaId(docId, replica_id)
  return replica_id
}
