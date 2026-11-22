// @ts-check
//
// Fault-injection matrix for the one invariant that matters: **no authored op
// is ever lost**. Runs in jsdom with `fake-indexeddb` — no browser, no WASM, no
// network — but with the *real* `createSyncClient`, oplog and doc cache, so
// persistence across a "restart" is genuine.
//
// The assertions are invariants, not mechanisms, so they survive a redesign:
//
//   I1  an op leaves the local oplog only after an ack for it
//   I2  every authored op is, at the end, on the server or still in the oplog
//   I3  every acked op is on the server
//   I4  after a clean reconnect, the client has applied everything the server has
//
// `it.fails` marks a KNOWN HOLE: the test body is the invariant we want, run
// against today's code. When the hole closes, that line goes red — flip it to
// `it` then. Nothing here is skipped.

import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSyncClient } from './sync-client.js'
import { enqueue, pendingFor, clearDoc as clearOplog } from './oplog.js'
import { clearDoc as clearCache, cacheOp } from './doc-cache.js'
import {
  FakeHub,
  FakeSocket,
  installWebSocket,
  makeModel,
  op,
  keyOf,
  settle,
} from './sync.faults.harness.js'

/** @typedef {Uint8Array} Payload */

describe('no lost ops (fault matrix)', () => {
  /** @type {FakeHub} */
  let hub
  /** @type {string} */
  let docId
  /** @type {() => void} */
  let restoreWS
  let counter = 0

  beforeEach(async () => {
    FakeSocket.instances = []
    hub = new FakeHub()
    docId = `doc-${Date.now()}-${counter++}`
    await clearOplog(docId).catch(() => {})
    await clearCache(docId).catch(() => {})
    restoreWS = installWebSocket(hub, () => docId)
  })

  afterEach(() => restoreWS())

  /**
   * @param {{ model?: ReturnType<typeof makeModel>, doc?: string }} [o]
   */
  function startClient(o = {}) {
    const model = o.model ?? makeModel()
    const client = createSyncClient({
      wsUrl: `wss://fake/ws/${o.doc ?? docId}`,
      docId: o.doc ?? docId,
      mergeOp: (p) => model.merge(/** @type {Payload} */ (p)),
      getToken: () => Promise.resolve('t'),
    })
    return { client, model }
  }

  /**
   * Simulate a reload: destroy the client and construct a new one over the same
   * IndexedDB and the same hub.
   * @param {ReturnType<typeof startClient>} prev
   */
  async function restart(prev) {
    prev.client.destroy()
    await settle(20)
    const next = startClient()
    await settle(120) // bootstrap + connect + replay
    return next
  }

  it('acks only what the server committed, and prunes on the ack', async () => {
    const c = startClient()
    await settle(60)

    const payload = op(1, 1)
    c.client.send(payload)
    await settle(40)
    expect(await pendingFor(docId)).toHaveLength(1) // durable before it is claimed

    hub.flush(docId)
    await settle(60)
    expect(await pendingFor(docId)).toHaveLength(0) // ack landed → pruned
    expect(hub.conflicts).toEqual([])
  })

  it('I2: a crash after send but before the ack does not lose the op', async () => {
    const c = startClient()
    await settle(60)

    hub.acksDropped = 1 // server commits, ack never reaches the client
    c.client.send(op(1, 1))
    await settle(40)
    hub.flush(docId)
    await settle(40)

    // The server has it, the client never acked it → still queued.
    expect(hub.doc(docId).size).toBe(1)
    expect(await pendingFor(docId)).toHaveLength(1)

    const next = await restart(c)
    // Replayed, re-acked (already committed), pruned.
    expect(await pendingFor(docId)).toHaveLength(0)
    expect(next.model.applied.has('1:1')).toBe(true)
  })

  it('I2: a server crash before the flush does not lose the op', async () => {
    const c = startClient()
    await settle(60)

    c.client.send(op(1, 1))
    await settle(40)
    expect(hub.doc(docId).size).toBe(0) // received, not durable
    hub.crash(docId) // pending dropped
    await settle(40)

    expect(await pendingFor(docId)).toHaveLength(1)

    const next = await restart(c)
    await settle(40)
    hub.flush(docId)
    await settle(60)
    expect(hub.doc(docId).size).toBe(1)
    expect(await pendingFor(docId)).toHaveLength(0)
    expect(next.model.applied.has('1:1')).toBe(true)
  })

  it('I4: a parked op is repaired by replaying the incomplete replica', async () => {
    // The server has 1..4. The client's cache has 1, 3 and 4 but not 2, so 3
    // parks on 2 — and 4 *applies*, because it branches off 1. That is what
    // makes this the gap case rather than the easy one: the watermark is now a
    // maximum at 4, so `since` alone would skip 2 for ever. Only remembering
    // "replica 4 is incomplete" gets it replayed from the floor.
    for (const seq of [1, 2]) hub.doc(docId).set(`4:${seq}`, op(4, seq))
    hub.doc(docId).set('4:3', op(4, 3))
    hub.doc(docId).set('4:4', op(4, 4, { dependsOn: '4:1' }))
    await cacheOp(docId, op(4, 1))
    await cacheOp(docId, op(4, 3))
    await cacheOp(docId, op(4, 4, { dependsOn: '4:1' }))

    const c = startClient()
    await settle(200)

    expect(c.model.parked.size).toBe(0)
    expect(c.model.applied.has('4:2')).toBe(true)
    expect(c.model.applied.has('4:4')).toBe(true)
  })

  it.fails('I4: a lost LEAF op is repaired (KNOWN HOLE: needs coverage, not a watermark)', async () => {
    // Every op is independent, so a missing one parks nothing at all — the
    // watermark is the only thing that could notice, and it is a maximum.
    // **KNOWN HOLE**: nothing in the client can see 5:2, because 5:3 applied
    // and raised the watermark to 3. Needs a detector that compares *coverage*
    // (a contiguous count) rather than a high-water mark.
    for (const seq of [1, 2, 3]) hub.doc(docId).set(`5:${seq}`, op(5, seq, { dependsOn: null }))
    await cacheOp(docId, op(5, 1, { dependsOn: null }))
    await cacheOp(docId, op(5, 3, { dependsOn: null })) // 5:2 is missing

    const c = startClient()
    await settle(200)

    expect(c.model.applied.has('5:2')).toBe(true)
  })

  it('I2/I3: two tabs writing the same replica do not silently lose the loser', async () => {
    // Same replica id, both start from the same last seq — the fork case. The PK
    // keeps the first; the second must be reported, not acked and forgotten.
    const a = startClient()
    await settle(60)
    a.client.send(op(1, 1, { tag: 'aaaa' }))
    await settle(40)
    hub.flush(docId)
    await settle(40)

    const b = startClient()
    await settle(60)
    b.client.send(op(1, 1, { tag: 'bbbb' })) // same (replica, seq), different bytes
    await settle(40)
    hub.flush(docId)
    await settle(60)

    expect(hub.conflicts).toContain('1:1')

    // The losing op must still exist somewhere: on the server, or queued here.
    const queued = (await pendingFor(docId)).map((p) => p.id)
    const stored = [...hub.doc(docId).values()].map((p) => keyOf(p))
    expect(queued.length + stored.length).toBeGreaterThan(0)
    expect(stored.includes('1:1')).toBe(true)
    // It was not acked, so it must not have been pruned.
    expect(queued.includes('1:1')).toBe(true)
  })

  // ── the server being short, and reordering/duplicating on the wire ────────

  it('I2: a client holding unacked ops resends them when the server is short', async () => {
    // The mirror of a lost server tail: the client has ops the server never got
    // (it crashed, or the write never landed). They live in the oplog, so a
    // reconnect must replay them — nothing on the server can ask for them.
    await enqueue(docId, '9:1', op(9, 1))
    await enqueue(docId, '9:2', op(9, 2))

    const c = startClient()
    await settle(160) // bootstrap + sync_done + replayPending
    expect(FakeSocket.instances[0].sentOps).toBe(2)

    hub.flush(docId)
    await settle(80)
    expect([...hub.doc(docId).keys()].sort()).toEqual(['9:1', '9:2'])
    expect(await pendingFor(docId)).toHaveLength(0)
    expect(c.model.applied.has('9:2')).toBe(true)
  })

  it('I4: an out-of-order stream parks, then heals itself in the same session', async () => {
    // Ops can arrive out of order (a replica's later op may depend on an earlier
    // one that is queued behind it). Parking must drain without a reconnect —
    // the op must end up applied, not stuck waiting for one.
    hub.doc(docId).set('7:1', op(7, 1))
    hub.doc(docId).set('7:2', op(7, 2))
    hub.streamTransform = (ops) => [ops[1], ops[0]]

    const c = startClient()
    await settle(200)
    expect(c.model.applied.has('7:1')).toBe(true)
    expect(c.model.applied.has('7:2')).toBe(true)
    expect(c.model.parked.size).toBe(0)

    // KNOWN COST: the park still writes a gap record, and nothing clears it
    // when the op drains in the same session. The next connect sees it, replays
    // replica 7 in full, and only then clears it (nothing fails on the replay).
    // Not loss — but a reorder on a large replica buys a full re-download.
    const gapKey = `rogue.gaps.${docId}`
    expect(globalThis.localStorage.getItem(gapKey)).not.toBeNull()

    await restart(c)
    expect(globalThis.localStorage.getItem(gapKey)).toBeNull()
  })

  it('I4: a duplicate delivery is idempotent (no park, no gap, no re-request)', async () => {
    hub.doc(docId).set('8:1', op(8, 1))
    hub.streamTransform = (ops) => [...ops, ...ops] // the same op twice

    const c = startClient()
    await settle(200)
    expect([...c.model.applied]).toEqual(['8:1'])
    expect(c.model.parked.size).toBe(0)
    expect(globalThis.localStorage.getItem(`rogue.gaps.${docId}`)).toBeNull()
  })

  // ── known holes: these are `it.fails` so they run, and flip red when fixed ─

  it.fails('I2: a read-only write is retried once, not for ever (KNOWN HOLE)', async () => {
    // The hub drops an op from a non-write peer with no ack and no error, which
    // is indistinguishable from packet loss: the client resends on every
    // reconnect, for ever, and the user's edit never reaches anyone.
    hub.readOnly = true

    const c = startClient()
    await settle(60)
    c.client.send(op(10, 1))
    await settle(60)
    expect(hub.refusals).toBe(1)

    let prev = c
    for (let i = 0; i < 2; i++) prev = await restart(prev)

    const sends = FakeSocket.instances.reduce((n, s) => n + s.sentOps, 0)
    // Today: 3 (one per connection). The op must become terminal — either
    // accepted, rejected-and-surfaced, or parked for a human — after one try.
    expect(sends, `the same op was sent ${sends} times`).toBe(1)
    expect(await pendingFor(docId)).toHaveLength(0)
  })

})
