// @ts-check
//
// Per-replica sync watermark for incremental sync. A single (seq, replica)
// high-water mark is wrong: a lagging replica can flush ops that slot in behind
// it, and those would be dropped. So we track, per replica, the highest seq
// we've merged.
//
// IMPORTANT: the watermark is *session-scoped* — it lives in memory alongside
// the CRDT state it describes. It must NOT be persisted (localStorage/…), or a
// reload would resume from a watermark the (fresh, empty) CRDT can't back up,
// and the server would skip ops the client actually needs. Persisting it is
// only safe once the client doc cache (persisted op log / state) exists.

import * as nodeIdV0 from '@pointyink/serde/node_id_v0'

/**
 * Advance a per-replica watermark with an op's group node id (the first 6 bytes
 * are node_id_v0). Mutates and returns `wm`.
 * @param {Record<string, number>} wm
 * @param {Uint8Array} payload
 * @returns {Record<string, number>}
 */
export function advanceWatermark(wm, payload) {
  if (payload.byteLength < nodeIdV0.SIZE) return wm
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const id = nodeIdV0.decode(view, 0)
  const cur = wm[id.replica_id] ?? -1
  if (id.sequence > cur) wm[id.replica_id] = id.sequence
  return wm
}

/**
 * Merge an op, then advance the watermark — only on success. If `mergeOp`
 * throws, the watermark is untouched, so the op is re-fetched next sync.
 * @param {(payload: Uint8Array) => void} mergeOp
 * @param {Record<string, number>} wm
 * @param {Uint8Array} payload
 * @returns {Record<string, number>}
 */
export function mergeAndAdvance(mergeOp, wm, payload) {
  mergeOp(payload)
  return advanceWatermark(wm, payload)
}

/**
 * Append the watermark as a `since` query param. Empty watermark → unchanged.
 *
 * `omit` names replicas whose history is known to be incomplete (a merge failed
 * for one of their ops). `since` is a per-replica seq floor, so it cannot ask
 * for one specific missing op — leaving the replica out makes the server replay
 * it in full, and merges are idempotent, so over-fetching is safe. Without this,
 * a later op from the same replica raises the floor past the hole and the
 * missing parent can never arrive.
 * @param {string} wsUrl
 * @param {Record<string, number>} wm
 * @param {Set<string>} [omit]
 * @returns {string}
 */
export function appendSince(wsUrl, wm, omit) {
  /** @type {Record<string, number>} */
  const kept = {}
  for (const [replica, seq] of Object.entries(wm)) {
    if (!omit?.has(replica)) kept[replica] = seq
  }
  const since = JSON.stringify(kept)
  if (since === '{}') return wsUrl
  const sep = wsUrl.includes('?') ? '&' : '?'
  return `${wsUrl}${sep}since=${encodeURIComponent(since)}`
}
