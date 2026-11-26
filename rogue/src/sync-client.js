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
import {
  cacheOp,
  cachedRows,
  maxSeqPerReplica,
  countPerReplica,
  markAcked,
  clearDoc as clearCacheDoc,
} from './doc-cache.js'
import { appendSince } from './checkpoint.js'
import * as multiOpV0 from '@pointyink/serde/multi_op_v0'
import * as ackV0 from '@pointyink/serde/ack_v0'
import * as nodeIdV0 from '@pointyink/serde/node_id_v0'

const DISC_MULTI_OP = 3
const DISC_ACK = 4
const DISC_JSON_ENVELOPE = 5

const FRAME_HEADER_BYTES = 2 + 4 // u16 disc + u32 len for variable types

// How many cached ops to merge before yielding to the event loop. The replay is
// a synchronous merge loop, and on a phone a few thousand ops in one task is
// long enough for Safari to kill the tab outright — the same thing a long loop
// looks like to the watchdog. Yielding lets it paint and keeps the timer alive;
// the chunk is a count rather than a time budget so the yield cost stays
// predictable (~n/250 macrotasks, each clamped to ~4 ms after nesting).
const REPLAY_CHUNK_OPS = 250

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
 * Split a payload's group id into its parts, or null when it is too short.
 * @param {Uint8Array} payload
 * @returns {{ replica: number, seq: number } | null}
 */
function groupParts(payload) {
  if (payload.byteLength < nodeIdV0.SIZE) return null
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const id = nodeIdV0.decode(view, 0)
  return { replica: id.replica_id, seq: id.sequence }
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
 * @typedef {'applied' | 'parked' | 'rejected' | 'deferred'} ApplyOutcome
 *
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
 *   mergeOp: (payload: Uint8Array) => (ApplyOutcome | void),
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

  // Per-replica `since`: the highest seq this client has *cached* for that
  // replica. `(replica, seq)` is a Lamport clock, so seqs have gaps by design —
  // a contiguous floor can never advance past the first one, and `since` would
  // then re-stream the replica on every connect (which is what 0.4.x did).
  // A count, not a floor, is how a hole is detected (see the plan doc); the max
  // is only "don't ask for what I already have".
  //
  // It is derived from the cached rows (`maxSeqPerReplica`) and advanced here
  // after a row is written, so it can never claim an op that is not on disk.
  /** @type {Record<string, number>} */
  const maxSeen = {}

  /**
   * Record that an op is now cached, so `since` need not ask for it again.
   * Monotonic; never persisted — it is re-derived from the rows on load.
   * @param {number} replica
   * @param {number} seq
   */
  function noteCached(replica, seq) {
    if (seq > (maxSeen[replica] ?? -1)) maxSeen[replica] = seq
  }

  /** @type {Set<string>} */
  /** localStorage key for the repair state: which replicas need a full replay,
   *  and how many replays each has already had. `since` itself is
   *  deliberately not persisted (see checkpoint.js), but a *gap* is different: it
   *  says "my history here is incomplete", which stays true across reloads until
   *  a replay fills it. Without this a hole is only noticed in the session that
   *  hits it — the failed op is never cached, so a reload can't rediscover it
   *  from the cache alone. */
  const repairKey = `rogue.gaps.${docId}`

  // A gap whose parent is genuinely absent from the server cannot be repaired by
  // asking again, so a replica gets at most this many full replays. Past that it
  // is marked unrepairable and left alone: re-downloading its whole history on
  // every connect would be a permanent bandwidth loop that never succeeds.
  const MAX_REPAIR_REPLAYS = 2

  /** @returns {{ gone: string[], attempts: Record<string, number>, countMisses: Record<string, number> }} */
  function loadRepairState() {
    try {
      const raw = globalThis.localStorage?.getItem(repairKey)
      if (!raw) return { gone: [], attempts: {}, countMisses: {} }
      const parsed = JSON.parse(raw)
      // Older/partial shapes degrade to "nothing known".
      return {
        gone: Array.isArray(parsed?.gone) ? parsed.gone.map(String) : [],
        attempts: parsed?.attempts && typeof parsed.attempts === 'object' ? parsed.attempts : {},
        countMisses:
          parsed?.countMisses && typeof parsed.countMisses === 'object' ? parsed.countMisses : {},
      }
    } catch {
      return { gone: [], attempts: {}, countMisses: {} }
    }
  }

  const initialRepair = loadRepairState()
  /** @type {Set<string>} replicas that need a full replay on the next connect */
  const incomplete = new Set(initialRepair.gone)
  /** @type {Map<string, number>} replica -> full replays attempted */
  const repairAttempts = new Map(
    Object.entries(initialRepair.attempts).map(([replica, n]) => [replica, Number(n)]),
  )

  function saveRepairState() {
    try {
      if (incomplete.size === 0 && repairAttempts.size === 0 && Object.keys(countMisses).length === 0) {
        globalThis.localStorage?.removeItem(repairKey)
        return
      }
      globalThis.localStorage?.setItem(
        repairKey,
        JSON.stringify({
          gone: [...incomplete],
          attempts: Object.fromEntries(repairAttempts),
          countMisses,
        }),
      )
    } catch {
      /* storage unavailable (private mode, server-side replica): in-memory only */
    }
  }

  // Serialises cache writes so the count check below can wait for them: a row
  // still in flight would look like a missing op and cost a full replay.
  /** @type {Promise<void>} */
  let cacheTail = Promise.resolve()

  // What the server says it holds, per replica, from this connection's
  // `sync_counts`. Compared with the cache at `sync_done`.
  /** @type {Record<string, {n: number, max: number}> | null} */
  let serverCounts = null

  // Replicas whose counts disagreed and did not heal after a replay. Kept apart
  // from `repairAttempts` because that budget is cleared whenever a connection
  // replays cleanly, which is exactly the case a persistent mismatch survives.
  /** @type {Record<string, number>} */
  const countMisses = { ...initialRepair.countMisses }

  // Did anything fail to merge on this connection? If not, a full replay of the
  // omitted replicas has healed them.
  let failedThisSync = false

  // Replicas this connection is replaying in full (omitted from `since`).
  /** @type {Set<string>} */
  let replaying = new Set()

  /**
   * Stop re-requesting a hole that two full replays could not fill.
   *
   * The repair loop is driven by `incomplete` (it is what omits a replica from
   * `since`), so dropping it here is the whole mechanism. Deliberately does NOT
   * advance `since`: `since` is derived from the rows, and moving it past an op
   * this client does not have would tell the server to skip content it still
   * holds. A genuine leaf gap is found by the per-replica count instead.
   * @param {string} replica
   */
  function giveUpOn(replica) {
    if (incomplete.delete(replica)) saveRepairState()
  }

  /**
   * Note that an op's replica has a hole this client can't fill locally.
   *
   * The repair (omitting the replica from `since`) takes effect on the **next**
   * connect: a live socket is not dropped just because one op failed, since a
   * forced reconnect here could flap. So a failure mid-session leaves that op
   * unapplied — readable document, one missing change — until the next natural
   * reconnect (network blip, token refresh, reload).
   * @param {Uint8Array} payload
   */
  function noteGap(payload) {
    if (payload.byteLength < nodeIdV0.SIZE) return
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const replica = String(nodeIdV0.decode(view, 0).replica_id)
    failedThisSync = true
    const attempts = repairAttempts.get(replica) ?? 0
    if (attempts >= MAX_REPAIR_REPLAYS) {
      // Known-unrepairable: its parent is not on the server. Leave it alone —
      // re-queuing it would restart the replay loop.
      giveUpOn(replica)
      return
    }
    if (replaying.has(replica)) {
      const next = attempts + 1
      repairAttempts.set(replica, next)
      if (next >= MAX_REPAIR_REPLAYS) {
        // The full replay we just asked for did not produce the parent. Stop
        // omitting the replica; surface it once and let the host offer a repair.
        incomplete.delete(replica)
        saveRepairState()
        console.error('[sync-client] gap unresolved after full replay:', { docId, replica })
        giveUpOn(replica)
        return
      }
      saveRepairState()
    }
    incomplete.add(replica)
    saveRepairState()
  }

  /**
   * Compare the server's per-replica counts with the cache. A server count above
   * the local one is an op that never arrived — the one failure `since` cannot
   * express, because a per-replica maximum cannot see a hole below it.
   *
   * On a mismatch the replica is omitted from `since` on the next connect, which
   * replays it in full; merges are idempotent, so that is over-fetch, not risk.
   * `countMisses` bounds that: a mismatch that survives a replay is not something
   * more fetching can fix (a failing cache write, a server hole), so it stops
   * after MAX_REPAIR_REPLAYS and says so instead of re-streaming for ever.
   */
  async function verifyCounts() {
    const expected = serverCounts
    if (!expected || !persist) return
    try {
      await cacheTail
    } catch {
      /* the write site logged it */
    }
    let local
    try {
      local = await countPerReplica(docId)
    } catch (err) {
      console.error('[sync-client] count read failed:', err)
      return
    }
    let changed = false
    for (const [replica, s] of Object.entries(expected)) {
      const have = local[replica] ?? 0
      const haveMax = maxSeen[replica] ?? -1
      if (s.n <= have && s.max <= haveMax) {
        if (replica in countMisses) {
          delete countMisses[replica]
          changed = true
        }
        continue
      }
      const misses = (countMisses[replica] ?? 0) + 1
      countMisses[replica] = misses
      changed = true
      if (misses > MAX_REPAIR_REPLAYS) {
        console.error('[sync-client] ops missing and not repairable by replay', {
          docId,
          replica,
          server: s,
          cached: have,
        })
        continue
      }
      if (!incomplete.has(replica)) {
        incomplete.add(replica)
        console.warn('[sync-client] missing ops — replaying this replica next connect', {
          docId,
          replica,
          server: s,
          cached: have,
        })
      }
    }
    if (changed) saveRepairState()
  }

  /** Merge an op, account for its bytes in the load meter, and (optionally)
   *  append it to the doc cache.
   *  @param {Uint8Array} payload
   *  @param {boolean} cache */
  function mergeAndAccount(payload, cache) {
    // Merge first. A *parked* op (dependency missing) is not applied — and the
    // engine parks rather than throwing, so the outcome, not just an exception,
    // decides whether we may claim it. Either way the replica is recorded: a
    // later op from it might merge fine and raise the floor past this hole, so
    // the gap has to be requested explicitly.
    /** @type {ApplyOutcome} */
    let outcome
    try {
      outcome = mergeOp(payload) ?? 'applied' 
      // Only a *parked* op is a hole: 'deferred' merely means an IME owns the DOM
      // and it will be applied on composition end — flagging it as a gap would
      // burn the repair budget and log a false "unresolved".
      if (outcome === 'parked') noteGap(payload)
    } catch (err) {
      noteGap(payload)
      throw err
    }
    completedBytes += payload.byteLength
    reportProgress(false)
    if (persist && cache) {
      // Note it only once the row exists, so `since` can never claim an op this
      // client cannot replay. Outcome does not matter: a parked or rejected op
      // is still ours, and asking for it again would be pure waste.
      cacheTail = cacheTail
        .then(() => cacheOp(docId, payload))
        .then(() => {
          const id = groupParts(payload)
          if (id) noteCached(id.replica, id.seq)
        })
        .catch((err) => console.error('[sync-client] cache write failed:', err))
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
          // A bad/out-of-order op: skip it — the cache row was not written, so
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
          // Nothing to advance: a cached row moved `since` when it was written.
          if (ids.length > 0) {
            // Two records of the same fact: the queue (oplog) drops it, and the
            // cache row marks it confirmed so a reload can tell pending from
            // settled. See plan-sync-model.md.
            ackMany(docId, ids).catch((err) =>
              console.error('[sync-client] ack drop failed:', err),
            )
            markAcked(
              docId,
              ack.group_ids.map((g) => ({ replica: g.replica_id, seq: g.sequence })),
            ).catch((err) => console.error('[sync-client] ack mark failed:', err))
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
        if (msg?.type === 'sync_counts') {
          // What the server holds per replica. Checked after this connection has
          // streamed and replayed, so it can only disagree for a real reason.
          /** @type {Record<string, {n: number, max: number}>} */
          const counts = {}
          for (const [replica, v] of Object.entries(msg.counts ?? {})) {
            const c = /** @type {{n?: unknown, max?: unknown}} */ (v)
            if (typeof c?.n === 'number' && typeof c?.max === 'number') {
              counts[replica] = { n: c.n, max: c.max }
            }
          }
          serverCounts = counts
          return
        }
        if (msg?.type === 'sync_done') {
          if (!ready) {
            // A replay that merged everything has healed whatever was missing.
            if (!failedThisSync && incomplete.size > 0) {
              incomplete.clear()
              repairAttempts.clear()
              saveRepairState()
            }
            // Replay pending ops, then mark ready + notify. The consumer
            // uses onReady to do its single first render and re-enable
            // editing, so ready must only go true once that's done.
            replayPending().then(() => {
              ready = true
              reportProgress(true)
              onReady?.()
              // After ready: a mismatch only affects the *next* connect, so the
              // check must not delay the first render.
              void verifyCounts()
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
          incomplete.clear()
          repairAttempts.clear()
          saveRepairState()
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
    failedThisSync = false

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

    replaying = new Set(incomplete)
    const url = appendSince(wsUrl, maxSeen, incomplete)
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
    opChain = opChain
      .then(async () => {
        // Cache first and independently of the oplog: the cache is what a
        // reload replays, so it has to survive an oplog failure or the edit
        // vanishes from the local doc. `own` marks it as ours, so bootstrap
        // knows which cached ops it may have to re-send.
        //
        // Neither write claims anything: `since` is built from the confirmed
        // floor, which moves only when this op's *ack* arrives. So a crash
        // between the two writes leaves an op the server has not been told
        // about — `reconcile` finds it at the next bootstrap and re-enqueues
        // it — instead of an op the server is told we already have.
        //
        // Awaited, not fired and forgotten: the ack can arrive at any moment
        // after `sendOpFrame`, and the ack path advances the floor. If the
        // write were still in flight (or had failed) the floor would claim an
        // op this client cannot replay — the stale-cache hole, one layer up.
        const id = extractGroupId(payload)
        if (persist) {
          try {
            await cacheOp(docId, payload, { own: true })
            const parts = groupParts(payload)
            if (parts) noteCached(parts.replica, parts.seq)
          } catch (err) {
            console.error('[sync-client] cache write failed:', err)
          }
        }
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
   * immediately, offline or while the WS is still dialing — and rebuilds
   * `since` from the rows actually present, so the first connect asks for a
   * history the client genuinely holds. Then connect for the delta.
   */
  async function bootstrap() {
    setStatus('connecting')
    if (!persist) {
      connect()
      return
    }
    // What we already have, per replica, before `connect` asks for the rest.
    try {
      Object.assign(maxSeen, await maxSeqPerReplica(docId))
    } catch (err) {
      console.error('[sync-client] floor load failed:', err)
    }
    try {
      const cached = (await cachedRows(docId)).map((r) => r.payload)
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
      let replayed = 0
      for (const payload of cached) {
        if (destroyed) return
        try {
          // The op is already in the cache, so replay skips re-caching
          // (mergeAndAccount(cache=false)).
          mergeAndAccount(payload, false)
        } catch (err) {
          console.error('[sync-client] cache replay failed:', err)
        }
        // Hand the main thread back regularly, or a large document is a
        // synchronous multi-second task — which iOS treats as a crash, not a
        // slow load.
        if (++replayed % REPLAY_CHUNK_OPS === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      }
    } catch (err) {
      console.error('[sync-client] cache load failed:', err)
    }
    // Ops the cache holds but the queue does not: an op that was applied
    // locally, cached, and then never enqueued (a crash between the two writes
    // in `send`, or a failed oplog write). Without this it would be replayed
    // into the doc on every load and never leave the machine.
    await reconcile()
    connect()
  }

  /**
   * Re-enqueue our own cached ops that the server has not confirmed and the
   * oplog no longer knows about. Idempotent: re-sending an op the server
   * already holds is a no-op insert plus a second ack, which also repairs the
   * floor. Only `own` rows are considered — another replica's op is the
   * server's to re-send, not ours.
   */
  async function reconcile() {
    if (!persist) return
    try {
      const [rows, pending] = await Promise.all([cachedRows(docId), pendingFor(docId)])
      const queued = new Set(pending.map((p) => p.id))
      for (const row of rows) {
        if (!row.own) continue
        const id = groupParts(row.payload)
        if (!id) continue
        // Only ops the server has not confirmed: an acked one is already there,
        // and re-sending every own op on every load would be a flood.
        if (row.acked) continue
        const groupId = `${id.replica}:${id.seq}`
        if (queued.has(groupId)) continue
        await enqueue(docId, groupId, row.payload)
        queued.add(groupId)
      }
    } catch (err) {
      console.error('[sync-client] reconcile failed:', err)
    }
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
