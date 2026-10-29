// @ts-check
//
// WebSocket-based sync transport for a Rogue doc. Encapsulates:
//   - WS lifecycle (connect, exponential-backoff reconnect)
//   - Outgoing op queue (IndexedDB-backed via oplog.js) — enqueue before send
//   - Incoming op + sync message dispatch — calls `mergeOp` for each
//   - Hard-ack handling — drops acked ops from the queue
//   - Replay on every open — resends anything still unacked
//
// Wire format (all binary frames; see serde/discriminators.md):
//   - Op (client↔server):   [disc=3 u16][len u32][multi_op_v0 bytes]
//   - Ack (server→client):  [disc=4 u16][len u32][ack_v0 bytes]
//   - Sync-done marker:     [disc=5 u16][len u32][json {"type":"sync_done"}]
//
// Consumer wires `mergeOp` to a rogue node's `mergeOp`, and pipes the node's
// `onCommit` into `syncClient.send`. Status changes (`connecting`/`connected`/
// `disconnected`) are reported via the optional `onStatus` callback.

import { enqueue, ackMany, pendingFor, pendingCount as pendingCountOp, clearDoc as clearOplogDoc } from './oplog.js'
import { cacheOp, cachedOps, clearDoc as clearCacheDoc } from './doc-cache.js'
import { advanceWatermark, mergeAndAdvance, appendSince } from './checkpoint.js'
import * as multiOpV0 from '@pointyink/serde/multi_op_v0'
import * as ackV0 from '@pointyink/serde/ack_v0'
import * as nodeIdV0 from '@pointyink/serde/node_id_v0'

const DISC_MULTI_OP = 3
const DISC_ACK = 4
const DISC_JSON_ENVELOPE = 5

const FRAME_HEADER_BYTES = 2 + 4 // u16 disc + u32 len for variable types

/**
 * Extract the group NodeId from a multi_op_v0 payload (first 6 bytes are the
 * node_id_v0 of the group). Returns "replica:sequence" as the stable id used
 * by the oplog. Returns null if the payload is too small.
 * @param {Uint8Array} payload
 * @returns {string | null}
 */
function extractGroupId(payload) {
  if (payload.byteLength < nodeIdV0.SIZE) return null
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const id = nodeIdV0.decode(view, 0)
  return `${id.replica_id}:${id.sequence}`
}

/**
 * Wrap a typed payload in the wire frame (disc + len + payload) and return
 * one Uint8Array suitable for WebSocket.send.
 * @param {number} disc
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
function frameVariable(disc, payload) {
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength)
  const view = new DataView(out.buffer)
  view.setUint16(0, disc, true)
  view.setUint32(2, payload.byteLength, true)
  out.set(payload, FRAME_HEADER_BYTES)
  return out
}

/**
 * @typedef {'connecting' | 'connected' | 'disconnected'} SyncStatus
 *
 * `persist` defaults to true: every merged op is appended to the IndexedDB doc
 * cache so a browser reload can resume offline. Server-side replicas that never
 * reload from local storage should pass false — the per-op cache writes dominate
 * cold-load time at scale, and the cache only grows for the process lifetime.
 *
 * @typedef {{
 *   wsUrl: string,
 *   docId: string,
 *   mergeOp: (payload: Uint8Array) => void,
 *   getToken: () => Promise<string>,
 *   onStatus?: (status: SyncStatus) => void,
 *   onReady?: () => void,
 *   onSyncStart?: (bytes: number) => void,
 *   onProgress?: (progress: number) => void,
 *   onCommentChanged?: (info: { comment_id: string, op: string }) => void,
 *   onSuggestionChanged?: (info: { suggestion_id: string, op: string }) => void,
 *   onDocDeleted?: (docId: string) => void,
 *   persist?: boolean,
 * }} SyncClientOptions
 *
 * @typedef {{
 *   send: (payload: Uint8Array) => void,
 *   sendDelete: () => void,
 *   destroy: () => void,
 *   isReady: () => boolean,
 *   pendingCount: () => Promise<number>,
 * }} SyncClient
 */

// Subprotocol marker the server (jwtauth.WSProtocol) negotiates; the JWT rides
// as the second offered subprotocol since browsers can't set WS headers.
const WS_PROTOCOL = 'rogue.jwt'

/**
 * @param {SyncClientOptions} options
 * @returns {SyncClient}
 */
export function createSyncClient({ wsUrl, docId, mergeOp, getToken, onStatus, onReady, onSyncStart, onProgress, onCommentChanged, onSuggestionChanged, onDocDeleted, persist = true }) {
  /** @type {WebSocket | null} */
  let ws = null
  let retryDelay = 1000
  let destroyed = false
  let ready = false // received the sync_done marker on this connection?

  // Load-progress tracking: `onSyncStart` advertises the total op bytes (cache
  // replay or WS sync_start), and we report completed/total as ops merge. Byte-
  // based, so it needs no per-op decode — the frame length is the unit.
  let totalBytes = 0
  let completedBytes = 0
  let lastProgressAt = 0
  /** @param {boolean} force */
  function reportProgress(force) {
    if (!onProgress || totalBytes === 0) return
    const now = Date.now()
    if (!force && now - lastProgressAt < 100) return
    lastProgressAt = now
    onProgress(Math.min(1, completedBytes / totalBytes))
  }

  /** @type {ReturnType<typeof setTimeout> | null} */
  let reconnectTimer = null

  // Serialize enqueue→send so a fast ack can't race ahead of the IndexedDB
  // write. Without this, a "drop on ack" might run before the corresponding
  // "enqueue" completed, leaving a stale entry that's resent forever (CRDT
  // idempotency rescues correctness but wastes bytes on every reconnect).
  let opChain = Promise.resolve()

  // Per-replica sync watermark: {"<replica>": <max seq>}. A single (seq, replica)
  // high-water mark would drop a lagging replica's ops, so we track the max seq
  // per replica — advanced by every op we merge (remote or our own). In-memory,
  // but rebuilt on load by replaying the doc cache (see bootstrap), so the
  // client can now safely resume across reloads.
  /** @type {Record<string, number>} */
  const watermark = {}

  /** Merge an op, account for its bytes in the load meter, and (optionally)
   *  append it to the doc cache.
   *  @param {Uint8Array} payload
   *  @param {boolean} cache */
  function mergeAndAccount(payload, cache) {
    // Merge first: if it throws (e.g. UnknownParent), the watermark is untouched
    // and the bytes aren't counted — the un-merged op is re-fetched next sync.
    mergeAndAdvance(mergeOp, watermark, payload)
    completedBytes += payload.byteLength
    reportProgress(false)
    if (persist && cache) {
      cacheOp(docId, payload).catch((err) =>
        console.error('[sync-client] cache write failed:', err),
      )
    }
  }

  /** Merge an op and append it to the doc cache (remote/WS path).
   *  @param {Uint8Array} payload */
  function mergeOpTracked(payload) {
    mergeAndAccount(payload, true)
  }

  /** @param {SyncStatus} s */
  function setStatus(s) {
    onStatus?.(s)
  }

  /** Send a multi_op_v0 payload over the WS as a framed binary message.
   *  @param {Uint8Array} payload */
  function sendOpFrame(payload) {
    ws?.send(/** @type {BufferSource} */ (frameVariable(DISC_MULTI_OP, payload)))
  }

  /**
   * Replay all unacked pending ops:
   *   1. Apply each locally first, so the user sees their unsent work
   *      immediately after reload (don't wait for the server to bounce it
   *      back). Idempotent via the CRDT's op_index.
   *   2. Send to the server, which persists, acks, and broadcasts.
   *
   * Must run *after* the bootstrap sync arrives — pending ops can have
   * `parent` ids that only exist in the sync history; applying before sync
   * would throw `UnknownParent`.
   */
  async function replayPending() {
    try {
      const items = await pendingFor(docId)
      for (const it of items) {
        try {
          mergeOpTracked(it.payload)
        } catch (err) {
          console.error('[sync-client] local replay apply failed:', err)
        }
        sendOpFrame(it.payload)
      }
    } catch (err) {
      console.error('[sync-client] replay failed:', err)
    }
  }

  /**
   * Dispatch one incoming WS binary frame by its discriminator.
   * @param {ArrayBuffer} buf
   */
  function handleBinaryFrame(buf) {
    if (buf.byteLength < 2) return
    const view = new DataView(buf)
    const disc = view.getUint16(0, true)
    switch (disc) {
      case DISC_MULTI_OP: {
        if (buf.byteLength < FRAME_HEADER_BYTES) return
        const len = view.getUint32(2, true)
        if (buf.byteLength < FRAME_HEADER_BYTES + len) return
        const payload = new Uint8Array(buf, FRAME_HEADER_BYTES, len)
        try {
          mergeOpTracked(payload)
        } catch (err) {
          // A bad/out-of-order op: skip it — the watermark wasn't advanced, so
          // it's re-fetched on the next sync.
          console.error('[sync-client] merge failed:', err)
        }
        return
      }
      case DISC_ACK: {
        if (buf.byteLength < FRAME_HEADER_BYTES) return
        const len = view.getUint32(2, true)
        const body = new Uint8Array(buf, FRAME_HEADER_BYTES, len)
        try {
          const ack = ackV0.decode(body)
          const ids = ack.group_ids.map((id) => `${id.replica_id}:${id.sequence}`)
          if (ids.length > 0) {
            ackMany(docId, ids).catch((err) =>
              console.error('[sync-client] ack drop failed:', err),
            )
          }
        } catch (err) {
          console.error('[sync-client] bad ack frame:', err)
        }
        return
      }
      case DISC_JSON_ENVELOPE: {
        if (buf.byteLength < FRAME_HEADER_BYTES) return
        const len = view.getUint32(2, true)
        const body = new Uint8Array(buf, FRAME_HEADER_BYTES, len)
        let msg
        try {
          msg = JSON.parse(new TextDecoder().decode(body))
        } catch {
          return
        }
        if (msg?.type === 'sync_start') {
          totalBytes = typeof msg.bytes === 'number' ? msg.bytes : 0
          completedBytes = 0
          onSyncStart?.(totalBytes)
          return
        }
        if (msg?.type === 'sync_done') {
          if (!ready) {
            // Replay pending ops, then mark ready + notify. The consumer
            // uses onReady to do its single first render and re-enable
            // editing, so ready must only go true once that's done.
            replayPending().then(() => {
              ready = true
              reportProgress(true)
              onReady?.()
            })
          }
        }
        if (msg?.type === 'comment_changed') {
          // A comment/reply changed server-side (REST). The consumer refetches
          // the thread list — the envelope only signals *that* something changed.
          onCommentChanged?.({ comment_id: msg.comment_id, op: msg.op })
        }
        if (msg?.type === 'suggestion_changed') {
          // A suggestion changed server-side (REST). Same signal-and-refetch
          // pattern as comments.
          onSuggestionChanged?.({ suggestion_id: msg.suggestion_id, op: msg.op })
        }
        if (msg?.type === 'doc_deleted') {
          // The doc was deleted server-side — stop retrying and flush local state.
          destroyed = true
          if (reconnectTimer) {
            clearTimeout(reconnectTimer)
            reconnectTimer = null
          }
          if (ws) {
            try { ws.close() } catch { /* already closed */ }
            ws = null
          }
          clearOplogDoc(docId).catch(() => {})
          clearCacheDoc(docId).catch(() => {})
          onDocDeleted?.(docId)
        }
        return
      }
      default:
        console.warn('[sync-client] unknown disc on incoming frame:', disc)
    }
  }

  function scheduleReconnect() {
    if (destroyed) return
    reconnectTimer = setTimeout(connect, retryDelay)
    retryDelay = Math.min(retryDelay * 2, 30000)
  }

  async function connect() {
    if (destroyed) return
    setStatus('connecting')
    ready = false

    // Fetch a fresh token every connect, so an expired token is transparently
    // refreshed on reconnect (the server closes the socket once `exp` passes).
    let token
    try {
      token = await getToken()
    } catch (err) {
      console.error('[sync-client] token fetch failed:', err)
      setStatus('disconnected')
      scheduleReconnect()
      return
    }
    if (destroyed) return

    const url = appendSince(wsUrl, watermark)
    ws = new WebSocket(url, [WS_PROTOCOL, token])
    ws.binaryType = 'arraybuffer'

    ws.addEventListener('open', () => {
      retryDelay = 1000
      setStatus('connected')
      // Don't replay yet — wait for the sync_done marker so pending ops can
      // resolve their parent ids in the merged history.
    })

    ws.addEventListener('close', () => {
      setStatus('disconnected')
      scheduleReconnect()
    })

    ws.addEventListener('message', (e) => {
      if (e.data instanceof ArrayBuffer) {
        handleBinaryFrame(e.data)
      } else {
        // Unexpected text frame — log and ignore. The protocol is binary
        // post-migration; if we ever resurrect a text channel it'll go here.
        console.warn('[sync-client] unexpected text frame:', e.data)
      }
    })
  }

  /** Send a CRDT op payload (multi_op_v0 bytes). Enqueued to oplog first so
   *  it survives reload before the server acks.
   *  @param {Uint8Array} payload */
  function send(payload) {
    // Our own op is already merged locally — advance the watermark so we don't
    // re-download it on the next reconnect, and cache it so a reload replays it.
    advanceWatermark(watermark, payload)
    if (persist) {
      cacheOp(docId, payload).catch((err) =>
        console.error('[sync-client] cache write failed:', err),
      )
    }
    opChain = opChain
      .then(async () => {
        const id = extractGroupId(payload)
        if (id) await enqueue(docId, id, payload)
        sendOpFrame(payload)
      })
      .catch((err) => console.error('[sync-client] enqueue/send failed:', err))
  }

  /** Ask the server to delete this doc (sync-native `delete_doc` message). The
   *  server authorizes the owner, tombstones the doc, and broadcasts the
   *  deletion to every connected client. No-op when the socket is down. */
  function sendDelete() {
    const payload = new TextEncoder().encode('{"type":"delete_doc"}')
    ws?.send(/** @type {BufferSource} */ (frameVariable(DISC_JSON_ENVELOPE, payload)))
  }

  function destroy() {
    destroyed = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (ws) {
      try { ws.close() } catch {}
      ws = null
    }
  }

  /**
   * Replay the cached op log into the (fresh) CRDT once on init, before the
   * first connect. This warms the doc from cache — the editor renders
   * immediately, offline or while the WS is still dialing — and rebuilds the
   * watermark from the ops actually present, so the first `since` reflects a
   * history the client genuinely holds. Then connect for the delta.
   */
  async function bootstrap() {
    setStatus('connecting')
    if (!persist) {
      connect()
      return
    }
    try {
      const cached = await cachedOps(docId)
      if (cached.length > 0) {
        let cacheBytes = 0
        for (const payload of cached) {
          cacheBytes += payload.byteLength
        }
        // Size hint for the cache replay — same hook as the WS sync_start, so
        // the warm-load replay reports determinate progress too (not just the
        // cold-load WS sync).
        totalBytes = cacheBytes
        completedBytes = 0
        onSyncStart?.(cacheBytes)
      }
      for (const payload of cached) {
        try {
          // Replay merges + advances the watermark, but the op is already in
          // the cache — mergeAndAccount(cache=false) skips re-caching.
          mergeAndAccount(payload, false)
        } catch (err) {
          console.error('[sync-client] cache replay failed:', err)
        }
      }
    } catch (err) {
      console.error('[sync-client] cache load failed:', err)
    }
    connect()
  }

  bootstrap()
  return {
    send,
    sendDelete,
    destroy,
    isReady: () => ready,
    /** Unacked local ops still queued for the server. Async: it counts in
     *  IndexedDB, so it stays correct across reloads and reconnects. */
    pendingCount: () => pendingCountOp(docId),
  }
}
