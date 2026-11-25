// @ts-check
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createSyncClient } from './sync-client.js'
import {
  cacheOp,
  cachedRows,
  maxSeqPerReplica,
  clearDoc as clearCacheDoc,
} from './doc-cache.js'
import { enqueue, pendingFor, ackMany, clearDoc as clearOplogDoc } from './oplog.js'
import * as ackV0 from '@pointyink/serde/ack_v0'

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
  cachedRows: vi.fn(() => Promise.resolve([])),
  maxSeqPerReplica: vi.fn(() => Promise.resolve({})),
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

  /** @type {Uint8Array[]} */
  sent = []

  /** @param {any} data */
  send(data) {
    if (data instanceof Uint8Array) this.sent.push(data)
    else if (data instanceof ArrayBuffer) this.sent.push(new Uint8Array(data))
  }

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
const DISC_ACK = 4
const DISC_JSON_ENVELOPE = 5

/** An ack_v0 payload for a list of [replica, seq] pairs.
 *  @param {Array<[number, number]>} pairs
 *  @returns {Uint8Array}
 */
function ackPayload(pairs) {
  return ackV0.encode(pairs.map(([replica_id, sequence]) => ({ replica_id, sequence })))
}

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

  it('sends the max cached seq as since on reconnect', async () => {
    start('wss://sync.example.com/ws/doc-1', 'doc-1', () => {})
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]

    // A contiguous run: each op the server streams confirms the next seq.
    for (const seq of [1, 2, 3]) ws.emitMessage(frame(DISC_MULTI_OP, opPayload(1, seq)))
    await new Promise((r) => setTimeout(r, 0))
    ws.emitClose()

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 3000 })
    expect(FakeWebSocket.instances[1].url).toBe(
      `wss://sync.example.com/ws/doc-1?since=${encodeURIComponent('{"1":3}')}`,
    )
  })

  it('asks from the max, because Lamport seqs have gaps by design', async () => {
    // A contiguous floor can never pass the first gap a Lamport clock produces
    // (1, 14, 27 is a normal replica), so `since` would re-stream for ever. The
    // max is the honest answer to "what do I already have"; a genuinely missing
    // op is found by comparing per-replica counts, not by this number.
    start('wss://sync.example.com/ws/doc-1', 'doc-1', () => {})
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]

    ws.emitMessage(frame(DISC_MULTI_OP, opPayload(1, 1)))
    ws.emitMessage(frame(DISC_MULTI_OP, opPayload(1, 3))) // 2 is missing
    await new Promise((r) => setTimeout(r, 0))
    ws.emitClose()

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 3000 })
    expect(FakeWebSocket.instances[1].url).toBe(
      `wss://sync.example.com/ws/doc-1?since=${encodeURIComponent('{"1":3}')}`,
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

  it('replays an op that was never acked, and never drops it locally', async () => {
    // The server may commit an op and die before its ack arrives. The op must
    // stay in the oplog and be replayed on the next connect — that is the only
    // copy of it until the ack lands.
    const pending = { id: '3:1', payload: opPayload(3, 1), ts: 1 }
    vi.mocked(pendingFor).mockResolvedValue([pending])
    start('wss://sync.example.com/ws/doc-1', 'doc-1', () => 'applied')
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]

    // Bootstrap complete: pending ops are replayed (re-applied + re-sent).
    ws.emitMessage(frame(DISC_JSON_ENVELOPE, new TextEncoder().encode('{"type":"sync_done"}')))
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0))

    // No ack arrived, so nothing was dropped from the queue.
    expect(vi.mocked(ackMany)).not.toHaveBeenCalled()

    // The socket dies and the client reconnects: the op is sent again.
    const before = ws.sent.length
    ws.emitClose()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 3000 })
    const ws2 = FakeWebSocket.instances[1]
    ws2.emitMessage(frame(DISC_JSON_ENVELOPE, new TextEncoder().encode('{"type":"sync_done"}')))
    await vi.waitFor(() => expect(ws2.sent.length).toBeGreaterThan(0))
    expect(before).toBeGreaterThan(0)
  })

  it('survives a cache write failure without claiming the op', async () => {
    // The cache is a rebuild accelerator; the oplog is the send queue. A failed
    // cache write must not stop the op being queued — but queued is not
    // confirmed, so `since` stays empty until an ack proves the server has it.
    vi.mocked(cacheOp).mockRejectedValueOnce(new Error('quota exceeded'))
    const client = start('wss://sync.example.com/ws/doc-1', 'doc-1', () => 'applied')
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    client.send(opPayload(5, 9))
    await vi.waitFor(() => expect(vi.mocked(enqueue)).toHaveBeenCalled())

    FakeWebSocket.instances[0].emitClose()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 3000 })
    const ws2 = FakeWebSocket.instances[1]
    ws2.emitMessage(frame(DISC_JSON_ENVELOPE, new TextEncoder().encode('{"type":"sync_done"}')))
    await vi.waitFor(() => expect(ws2.sent.length).toBeGreaterThan(0))
    expect(ws2.url).toBe('wss://sync.example.com/ws/doc-1')
  })

  it('does not treat an IME-deferred op as a gap', async () => {
    // 'deferred' means the engine is holding the op until the composition ends.
    // It is still ours and still cached, so `since` may pass it — but it is not a
    // hole, and marking it as one would burn the repair budget for nothing.
    start('wss://sync.example.com/ws/doc-1', 'doc-1', () => 'deferred')
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]

    ws.emitMessage(frame(DISC_MULTI_OP, opPayload(2, 4)))
    ws.emitClose()

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 3000 })
    expect(decodeURIComponent(FakeWebSocket.instances[1].url)).toContain('"2":4')
    expect(localStorage.getItem('rogue.gaps.doc-1')).toBe(null)
  })

  it('does not advance the watermark when the engine parks the op', async () => {
    // The engine parks an op whose parent hasn't arrived and returns normally —
    // it does not throw. Treating that as merged is the actual production bug:
    // `since` then skips it for ever and the edit is invisible after a reload.
    start('wss://sync.example.com/ws/doc-1', 'doc-1', (p) => {
      const seq = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(2, true)
      return seq === 12 ? 'parked' : 'applied'
    })
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const ws = FakeWebSocket.instances[0]

    ws.emitMessage(frame(DISC_MULTI_OP, opPayload(1, 12))) // parked
    ws.emitMessage(frame(DISC_MULTI_OP, opPayload(1, 13))) // applies, must not hide 12
    ws.emitClose()

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 3000 })
    // Replica 1 is omitted from `since` (the gap), so the hole is requested again.
    expect(FakeWebSocket.instances[1].url).toBe('wss://sync.example.com/ws/doc-1')
    const gaps = localStorage.getItem('rogue.gaps.doc-1')
    expect(gaps ?? '').toContain('1')
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

  it('keeps the cache copy when the oplog write fails', async () => {
    // The oplog is the send queue; the cache is what a reload replays. An
    // enqueue failure must not cost the op both, or the edit vanishes on reload.
    vi.mocked(enqueue).mockRejectedValueOnce(new Error('quota exceeded'))
    const client = start('wss://sync.example.com/ws/doc-1', 'doc-1', () => {})
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    client.send(opPayload(7, 43))
    await vi.waitFor(() =>
      expect(vi.mocked(cacheOp)).toHaveBeenCalledWith('doc-1', expect.any(Uint8Array), {
        own: true,
      }),
    )
  })

  it('stops replaying a replica whose parent never arrives', async () => {
    // A full replay that still fails means the parent is not on the server.
    // Omitting the replica on every reconnect would re-download its whole
    // history for ever, so after a couple of attempts we give up and keep the
    // ops unapplied instead.
    const fail = () => {
      throw new Error('UnknownParent')
    }
    for (let session = 0; session < 4; session++) {
      const before = FakeWebSocket.instances.length
      const client = start('wss://sync.example.com/ws/doc-1', 'doc-1', fail)
      await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(before))
      const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
      ws.emitMessage(frame(DISC_MULTI_OP, opPayload(9, 1)))
      ws.emitMessage(frame(DISC_JSON_ENVELOPE, new TextEncoder().encode('{"type":"sync_done"}')))
      client.destroy()
    }
    // After MAX_REPAIR_REPLAYS failed replays the replica is no longer queued
    // for a replay, and the count is remembered so it can't be re-queued later.
    const raw = localStorage.getItem('rogue.gaps.doc-1')
    const state = raw ? JSON.parse(raw) : { gone: [], attempts: {} }
    expect(state.gone).not.toContain('9')
    expect(state.attempts['9']).toBe(2)
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
    vi.mocked(cachedRows).mockResolvedValueOnce([{ payload: opPayload(4, 8), own: false, acked: true }])
    const second = start('wss://sync.example.com/ws/doc-1', 'doc-1', () => {})
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    // Replica 4 is omitted from `since`, so the server replays it in full.
    expect(FakeWebSocket.instances[1].url).toBe('wss://sync.example.com/ws/doc-1')
    second.destroy()
  })

  it('claims what it has cached, and keeps resending until the ack', async () => {
    // Claiming a cached op is safe: it is on disk here, and if the server never
    // got it the oplog still holds it and the periodic retry resends it. The
    // ack is what stops the resend, not what makes the claim true.
    const client = start('wss://sync.example.com/ws/doc-1', 'doc-1', () => {})
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    client.send(opPayload(7, 1))
    await vi.waitFor(() => expect(vi.mocked(enqueue)).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))

    FakeWebSocket.instances[0].emitClose()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 3000 })
    // It is cached, so `since` claims it; it is also still queued, so it is
    // resent. Both are true at once, which is the point.
    expect(decodeURIComponent(FakeWebSocket.instances[1].url)).toContain('"7":1')
    expect(await pendingFor('doc-1')).toHaveLength(1)

    // The ack drops it from the queue.
    FakeWebSocket.instances[1].emitMessage(frame(DISC_ACK, ackPayload([[7, 1]])))
    await new Promise((r) => setTimeout(r, 0))
    expect(vi.mocked(ackMany)).toHaveBeenCalled()
  })

  it('does not claim an op whose cache write failed', async () => {
    // The server may have it, but this client could not cache it. `since` is
    // derived from the rows, so a failed write leaves it below — the next
    // connect asks for it again and the cache is repaired.
    vi.mocked(cacheOp).mockRejectedValueOnce(new Error('quota exceeded'))
    const client = start('wss://sync.example.com/ws/doc-1', 'doc-1', () => 'applied')
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    client.send(opPayload(7, 1))
    await vi.waitFor(() => expect(vi.mocked(enqueue)).toHaveBeenCalled())

    FakeWebSocket.instances[0].emitMessage(frame(DISC_ACK, ackPayload([[7, 1]])))
    await new Promise((r) => setTimeout(r, 0))

    FakeWebSocket.instances[0].emitClose()
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 3000 })
    expect(FakeWebSocket.instances[1].url).toBe('wss://sync.example.com/ws/doc-1')
  })

  it('replays the cached op log and resumes from the max cached seq (reload resume)', async () => {
    vi.mocked(cachedRows).mockResolvedValueOnce([
      { payload: opPayload(1, 10), own: false, acked: true },
      { payload: opPayload(2, 5), own: false, acked: true },
    ])
    // What the previous session durably confirmed for those replicas.
    vi.mocked(maxSeqPerReplica).mockResolvedValueOnce({ 1: 10, 2: 5 })

    /** @type {Uint8Array[]} */
    const merged = []
    start('wss://sync.example.com/ws/doc-1', 'doc-1', (p) => merged.push(p))

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    expect(merged).toHaveLength(2)
    // The first dial resumes from the highest seq actually cached per replica —
    // derived from the rows, so it cannot claim an op this client cannot play.
    expect(FakeWebSocket.instances[0].url).toBe(
      `wss://sync.example.com/ws/doc-1?since=${encodeURIComponent('{"1":10,"2":5}')}`,
    )
  })

  it('does not re-cache ops during replay', async () => {
    vi.mocked(cachedRows).mockResolvedValueOnce([{ payload: opPayload(1, 10), own: false, acked: true }])

    start('wss://sync.example.com/ws/doc-1', 'doc-1', () => {})
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    // Replay merges via mergeAndAdvance (no cacheOp); nothing should be written.
    expect(vi.mocked(cacheOp)).not.toHaveBeenCalled()
  })

  it('yields between replay chunks so a big document cannot block the page', async () => {
    // On iOS a long synchronous task is a *crash*, not a slow load: the page is
    // killed for blocking the main thread. The replay is the longest task on the
    // load path, so it has to hand the thread back regularly.
    const count = 600
    vi.mocked(cachedRows).mockResolvedValueOnce(
      Array.from({ length: count }, (_, i) => ({ payload: opPayload(1, i + 1), own: false, acked: true })),
    )

    /** @type {string[]} */
    const order = []
    start('wss://sync.example.com/ws/doc-1', 'doc-1', (p) => {
      const seq = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(2, true)
      order.push(`merge:${seq}`)
      return 'applied'
    })

    // Scheduled before the loop starts, so it can only run at a yield inside it.
    setTimeout(() => order.push('tick'), 0)

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    expect(order.filter((x) => x.startsWith('merge:'))).toHaveLength(count)
    const tick = order.indexOf('tick')
    expect(tick, 'the replay never yielded').toBeGreaterThan(0)
    expect(tick).toBeLessThan(order.lastIndexOf(`merge:${count}`))
  })

  it('sizes the cache replay so it reports progress (reload warm start)', async () => {
    // Two cached ops (10 bytes each).
    const op1 = opPayload(1, 10)
    const op2 = opPayload(2, 5)
    vi.mocked(cachedRows).mockResolvedValueOnce([
      { payload: op1, own: false, acked: true },
      { payload: op2, own: false, acked: true },
    ])

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
    vi.mocked(cachedRows).mockResolvedValueOnce([])

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

  it('caches our own op when sent, marked as ours', async () => {
    const client = start('wss://sync.example.com/ws/doc-1', 'doc-1', () => {})
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    client.send(opPayload(1, 10))
    // The provenance flag is what lets bootstrap tell "an op I authored and may
    // still owe the server" from "an op the server gave me".
    await vi.waitFor(() =>
      expect(vi.mocked(cacheOp)).toHaveBeenCalledWith('doc-1', expect.any(Uint8Array), {
        own: true,
      }),
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
