// @ts-check
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createSyncClient } from './sync-client.js'
import { cacheOp, cachedOps, clearDoc as clearCacheDoc } from './doc-cache.js'
import { enqueue, clearDoc as clearOplogDoc } from './oplog.js'

// Mock the IndexedDB-backed oplog so we don't need a real IndexedDB.
vi.mock('./oplog.js', () => ({
  enqueue: vi.fn(() => Promise.resolve()),
  ackMany: vi.fn(() => Promise.resolve()),
  pendingFor: vi.fn(() => Promise.resolve([])),
  clearDoc: vi.fn(() => Promise.resolve()),
}))

// Mock the doc cache the same way; the real IndexedDB logic lives in
// doc-cache.test.js (backed by fake-indexeddb).
vi.mock('./doc-cache.js', () => ({
  cacheOp: vi.fn(() => Promise.resolve()),
  cachedOps: vi.fn(() => Promise.resolve([])),
  clearDoc: vi.fn(() => Promise.resolve()),
}))

/** Minimal fake WebSocket that records the dial URL and lets tests dispatch events. */
class FakeWebSocket {
  /** @type {FakeWebSocket[]} */
  static instances = []

  /** @type {string} */
  url

  /** @type {string[]} */
  protocols

  /** @type {Record<string, ((e: any) => void)[]>} */
  listeners = {}

  /**
   * @param {string} url
   * @param {string[]} protocols
   */
  constructor(url, protocols) {
    this.url = url
    this.protocols = protocols
    FakeWebSocket.instances.push(this)
  }

  /** @param {string} type @param {(e: any) => void} fn */
  addEventListener(type, fn) {
    ;(this.listeners[type] ||= []).push(fn)
  }

  /** @param {any} data */
  send(data) {}

  close() {}

  /** @param {string} type @param {any} event */
  dispatch(type, event) {
    for (const fn of this.listeners[type] || []) fn(event)
  }

  /** @param {any} data */
  emitMessage(data) {
    this.dispatch('message', { data })
  }

  emitClose() {
    this.dispatch('close', {})
  }
}

/** Wrap a payload in a [disc u16][len u32][payload] binary frame.
 *  @param {number} disc
 *  @param {Uint8Array} payload
 */
function frame(disc, payload) {
  const out = new Uint8Array(6 + payload.length)
  const view = new DataView(out.buffer)
  view.setUint16(0, disc, true)
  view.setUint32(2, payload.length, true)
  out.set(payload, 6)
  return out.buffer
}

/** A multi_op payload whose first 6 bytes are node_id_v0(replica, sequence).
 *  @param {number} replicaId
 *  @param {number} sequence
 */
function opPayload(replicaId, sequence) {
  const out = new Uint8Array(6 + 4)
  const view = new DataView(out.buffer)
  view.setUint16(0, replicaId, true)
  view.setUint32(2, sequence, true)
  return out
}

const DISC_MULTI_OP = 3
const DISC_JSON_ENVELOPE = 5

/** @param {string} url @param {string} docId @param {(p: Uint8Array) => void} mergeOp */
function start(url, docId, mergeOp) {
  return createSyncClient({
    wsUrl: url,
    docId,
    mergeOp,
    getToken: () => Promise.resolve('token-1'),
  })
}

beforeEach(() => {
  localStorage.clear()
  FakeWebSocket.instances = []
  vi.clearAllMocks()
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createSyncClient checkpoint', () => {
  it('dials without a since param on a fresh session', async () => {
    start('wss://sync.example.com/ws/doc-1', 'doc-1', () => {})

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    expect(FakeWebSocket.instances[0].url).toBe('wss://sync.example.com/ws/doc-1')
  })

  it('ignores a stale persisted checkpoint (regression: reload must full-sync)', async () => {
    // A leftover checkpoint from a previous session must NOT be trusted: the
    // in-memory CRDT is gone, so resuming from it would skip ops the client
    // actually needs.
    localStorage.setItem('rogue.checkpoint.doc-1', '{"55608":63,"63470":237}')

    start('wss://sync.example.com/ws/doc-1', 'doc-1', () => {})

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    expect(FakeWebSocket.instances[0].url).toBe('wss://sync.example.com/ws/doc-1')
  })

  it('sends the advanced watermark as since on reconnect', async () => {
    start('wss://sync.example.com/ws/doc-1', 'doc-1', () => {})
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]

    ws.emitMessage(frame(DISC_MULTI_OP, opPayload(1, 10)))
    ws.emitClose()

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 3000 })
    expect(FakeWebSocket.instances[1].url).toBe(
      `wss://sync.example.com/ws/doc-1?since=${encodeURIComponent('{"1":10}')}`,
    )
  })

  it('does not advance the watermark when a merge throws', async () => {
    start('wss://sync.example.com/ws/doc-1', 'doc-1', () => {
      throw new Error('UnknownParent')
    })
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]

    ws.emitMessage(frame(DISC_MULTI_OP, opPayload(1, 10)))
    ws.emitClose()

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 3000 })
    // The failed op never merged, so the watermark is still empty → no since.
    expect(FakeWebSocket.instances[1].url).toBe('wss://sync.example.com/ws/doc-1')
  })

  it('re-requests a replica whose history has a hole (a later op must not hide it)', async () => {
    // Op 10 fails with UnknownParent, then op 11 from the same replica merges.
    // A max watermark moves to 11 and the server never resends 10 — the classic
    // permanent hole: 10's children park forever. The replica must be requested
    // again instead.
    start('wss://sync.example.com/ws/doc-1', 'doc-1', (p) => {
      const seq = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(2, true)
      if (seq === 10) throw new Error('UnknownParent')
    })
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]

    ws.emitMessage(frame(DISC_MULTI_OP, opPayload(1, 10))) // fails
    ws.emitMessage(frame(DISC_MULTI_OP, opPayload(1, 11))) // merges, hides the hole today
    ws.emitClose()

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 3000 })
    expect(FakeWebSocket.instances[1].url).toBe('wss://sync.example.com/ws/doc-1')
  })

  it('remembers a hole across reloads (the failed op is never cached)', async () => {
    // Session 1: a merge fails. The failed op is not in the cache, so a reload
    // cannot rediscover it from the cache — the gap has to be remembered or the
    // replica's floor hides it for ever.
    start('wss://sync.example.com/ws/doc-1', 'doc-1', () => {
      throw new Error('UnknownParent')
    })
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    FakeWebSocket.instances[0].emitMessage(frame(DISC_MULTI_OP, opPayload(4, 7)))

    // Session 2: fresh client whose cache holds a *later* op from the same
    // replica. Without the remembered gap that op would set the floor to 4:8 and
    // hide 4:7 for ever.
    vi.mocked(cachedOps).mockResolvedValueOnce([opPayload(4, 8)])
    start('wss://sync.example.com/ws/doc-1', 'doc-1', () => {})
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    // Replica 4 is omitted from `since`, so the server replays it in full.
    expect(FakeWebSocket.instances[1].url).toBe('wss://sync.example.com/ws/doc-1')
  })

  it('does not advance the watermark when the op was never queued', async () => {
    // The oplog write is the only durable copy of an unsent op. If it fails, the
    // op exists in memory only; advancing the watermark would tell the next sync
    // "I already have it", and the server would never send it back.
    vi.mocked(enqueue).mockRejectedValueOnce(new Error('quota exceeded'))
    const client = start('wss://sync.example.com/ws/doc-1', 'doc-1', () => {})
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    client.send(opPayload(7, 42))
    await vi.waitFor(() => expect(vi.mocked(enqueue)).toHaveBeenCalled())

    FakeWebSocket.instances[0].emitClose()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 3000 })
    expect(FakeWebSocket.instances[1].url).toBe('wss://sync.example.com/ws/doc-1')
  })

  it('replays the cached op log and resumes from its watermark (reload resume)', async () => {
    vi.mocked(cachedOps).mockResolvedValueOnce([opPayload(1, 10), opPayload(2, 5)])

    /** @type {Uint8Array[]} */
    const merged = []
    start('wss://sync.example.com/ws/doc-1', 'doc-1', (p) => merged.push(p))

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    expect(merged).toHaveLength(2)
    // The watermark is rebuilt from the cached ops, so the first dial resumes
    // from exactly the history the client actually holds.
    expect(FakeWebSocket.instances[0].url).toBe(
      `wss://sync.example.com/ws/doc-1?since=${encodeURIComponent('{"1":10,"2":5}')}`,
    )
  })

  it('does not re-cache ops during replay', async () => {
    vi.mocked(cachedOps).mockResolvedValueOnce([opPayload(1, 10)])

    start('wss://sync.example.com/ws/doc-1', 'doc-1', () => {})
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    // Replay merges via mergeAndAdvance (no cacheOp); nothing should be written.
    expect(vi.mocked(cacheOp)).not.toHaveBeenCalled()
  })

  it('sizes the cache replay so it reports progress (reload warm start)', async () => {
    // Two cached ops (10 bytes each).
    const op1 = opPayload(1, 10)
    const op2 = opPayload(2, 5)
    vi.mocked(cachedOps).mockResolvedValueOnce([op1, op2])

    const onSyncStart = vi.fn()
    createSyncClient({
      wsUrl: 'wss://sync.example.com/ws/doc-1',
      docId: 'doc-1',
      mergeOp: () => {},
      getToken: () => Promise.resolve('token-1'),
      onSyncStart,
    })

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    // bytes = sum of cached payload byte lengths.
    expect(onSyncStart).toHaveBeenCalledWith(op1.byteLength + op2.byteLength)
  })

  it('does not size an empty cache replay', async () => {
    vi.mocked(cachedOps).mockResolvedValueOnce([])

    const onSyncStart = vi.fn()
    createSyncClient({
      wsUrl: 'wss://sync.example.com/ws/doc-1',
      docId: 'doc-1',
      mergeOp: () => {},
      getToken: () => Promise.resolve('token-1'),
      onSyncStart,
    })

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    expect(onSyncStart).not.toHaveBeenCalled()
  })

  it('reports byte progress as ops merge between sync_start and sync_done', async () => {
    const onProgress = vi.fn()
    createSyncClient({
      wsUrl: 'wss://sync.example.com/ws/doc-1',
      docId: 'doc-1',
      mergeOp: () => {},
      getToken: () => Promise.resolve('token-1'),
      onProgress,
    })

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]

    ws.emitMessage(frame(DISC_JSON_ENVELOPE, new TextEncoder().encode('{"type":"sync_start","bytes":10}')))
    ws.emitMessage(frame(DISC_MULTI_OP, opPayload(1, 10))) // 10 bytes → 100%
    ws.emitMessage(frame(DISC_JSON_ENVELOPE, new TextEncoder().encode('{"type":"sync_done"}')))

    await vi.waitFor(() => expect(onProgress).toHaveBeenCalled())
    expect(onProgress).toHaveBeenCalledWith(1)
  })

  it('caches a merged remote op', async () => {
    start('wss://sync.example.com/ws/doc-1', 'doc-1', () => {})
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    FakeWebSocket.instances[0].emitMessage(frame(DISC_MULTI_OP, opPayload(1, 10)))
    expect(vi.mocked(cacheOp)).toHaveBeenCalledWith('doc-1', expect.any(Uint8Array))
  })

  it('fires onCommentChanged for a comment_changed envelope', async () => {
    const onCommentChanged = vi.fn()
    createSyncClient({
      wsUrl: 'wss://sync.example.com/ws/doc-1',
      docId: 'doc-1',
      mergeOp: () => {},
      getToken: () => Promise.resolve('token-1'),
      onCommentChanged,
    })

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.emitMessage(frame(DISC_JSON_ENVELOPE, new TextEncoder().encode('{"type":"comment_changed","comment_id":"c1","op":"created"}')))

    expect(onCommentChanged).toHaveBeenCalledWith({ comment_id: 'c1', op: 'created' })
  })

  it('fires onSuggestionChanged for a suggestion_changed envelope', async () => {
    const onSuggestionChanged = vi.fn()
    createSyncClient({
      wsUrl: 'wss://sync.example.com/ws/doc-1',
      docId: 'doc-1',
      mergeOp: () => {},
      getToken: () => Promise.resolve('token-1'),
      onSuggestionChanged,
    })

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]
    ws.emitMessage(frame(DISC_JSON_ENVELOPE, new TextEncoder().encode('{"type":"suggestion_changed","suggestion_id":"s1","op":"created"}')))

    expect(onSuggestionChanged).toHaveBeenCalledWith({ suggestion_id: 's1', op: 'created' })
  })

  it('caches our own op when sent', async () => {
    const client = start('wss://sync.example.com/ws/doc-1', 'doc-1', () => {})
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    client.send(opPayload(1, 10))
    // The cache write happens after the op is durably queued (enqueue → claim →
    // cache), so it lands on a later microtask.
    await vi.waitFor(() =>
      expect(vi.mocked(cacheOp)).toHaveBeenCalledWith('doc-1', expect.any(Uint8Array)),
    )
  })

  it('clears local state and fires onDocDeleted on a doc_deleted envelope', async () => {
    const onDocDeleted = vi.fn()
    createSyncClient({
      wsUrl: 'wss://sync.example.com/ws/doc-1',
      docId: 'doc-1',
      mergeOp: () => {},
      getToken: () => Promise.resolve('token-1'),
      onDocDeleted,
    })
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]

    ws.emitMessage(frame(DISC_JSON_ENVELOPE, new TextEncoder().encode('{"type":"doc_deleted"}')))

    await vi.waitFor(() => expect(onDocDeleted).toHaveBeenCalledWith('doc-1'))
    expect(vi.mocked(clearOplogDoc)).toHaveBeenCalledWith('doc-1')
    expect(vi.mocked(clearCacheDoc)).toHaveBeenCalledWith('doc-1')
  })
})
