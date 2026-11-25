// @ts-check
//
// The other half of "no lost ops": the *local* write path. The invariants in
// `sync.faults.test.js` all assume the op reached the oplog. This file breaks
// that assumption on purpose.
//
// The op is written to two places in `send()`: the doc cache (a rebuild
// accelerator, fire-and-forget) and the oplog (the send queue, awaited). Only
// the oplog write gates the watermark. So:
//
//   cache ok, oplog fail  → NOT claimed  (correct: the op is still unsent)
//
// …but the next reload rebuilds the watermark **from the cache**, which *does*
// have the op. The claim comes back, the oplog has nothing to replay, and the
// op is never sent: a permanent, silent divergence that no server-side count or
// hash can detect, because the server never hears about the op at all.
//
// That is the case this file exists to pin down.

import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createSyncClient } from './sync-client.js'
import { pendingFor, clearDoc as clearOplog } from './oplog.js'
import { cachedOps, clearDoc as clearCache } from './doc-cache.js'
import { FakeHub, FakeSocket, installWebSocket, makeModel, op, settle } from './sync.faults.harness.js'

// A quota/private-mode failure on exactly one call, then back to the real store.
const gate = vi.hoisted(() => ({ failEnqueue: false }))

vi.mock('./oplog.js', async (importOriginal) => {
  const real = /** @type {typeof import('./oplog.js')} */ (await importOriginal())
  return {
    ...real,
    /** @param {...any} args */
    enqueue: (...args) =>
      gate.failEnqueue
        ? Promise.reject(new Error('QuotaExceededError'))
        : real.enqueue(/** @type {any} */ (args[0]), args[1], args[2]),
  }
})

describe('no lost ops (local write failures)', () => {
  /** @type {FakeHub} */
  let hub
  /** @type {string} */
  let docId
  /** @type {() => void} */
  let restoreWS
  let counter = 0

  beforeEach(async () => {
    hub = new FakeHub()
    docId = `local-${Date.now()}-${counter++}`
    gate.failEnqueue = false
    await clearOplog(docId).catch(() => {})
    await clearCache(docId).catch(() => {})
    restoreWS = installWebSocket(hub, () => docId)
  })

  /**
   * @param {ReturnType<typeof makeModel>} [model]
   */
  function startClient(model = makeModel()) {
    const client = createSyncClient({
      wsUrl: `wss://fake/ws/${docId}`,
      docId,
      mergeOp: (p) => model.merge(/** @type {any} */ (p)),
      getToken: () => Promise.resolve('t'),
    })
    return { client, model }
  }

  /** The `since` map the most recent socket asked for. */
  function lastSince() {
    const url = FakeSocket.instances.at(-1)?.url ?? ''
    const raw = new URL(url).searchParams.get('since')
    return raw ? JSON.parse(raw) : {}
  }

  it('a failed oplog write does not claim the op (it is still unsent)', async () => {
    const c = startClient()
    await settle(60)

    gate.failEnqueue = true
    c.client.send(op(12, 1))
    await settle(80)
    gate.failEnqueue = false

    // Nothing durable to replay…
    expect(await pendingFor(docId)).toHaveLength(0)
    // …but the cache write went through, because the two are independent.
    expect(await cachedOps(docId)).toHaveLength(1)
  })

  it('I2: an op that is only in the cache still reaches the server', async () => {
    const a = startClient()
    await settle(60)

    // The oplog write fails after the cache write has already landed: the
    // window a crash lands in. The op is applied, cached, and never queued.
    gate.failEnqueue = true
    a.client.send(op(12, 1))
    await settle(80)
    gate.failEnqueue = false
    expect(await pendingFor(docId)).toHaveLength(0)

    a.client.destroy()
    await settle(20)
    const b = startClient()
    await settle(200) // bootstrap → reconcile → sync_done → replay

    expect(b.model.applied.has('12:1')).toBe(true) // the local doc keeps the edit
    // Claimed, because it *is* cached: `since` is the max cached seq. Safe only
    // because the row is unacked, so it is reconciled into the queue and resent —
    // which is the next assertion. Claiming what you have and resending what the
    // server has not confirmed are complementary, not a contradiction.
    expect(lastSince()['12']).toBe(1)
    // …and not stranded either: reconcile put it back in the queue and the
    // reconnect's replay got it to the server.
    hub.flush(docId)
    await settle(60)
    expect(
      hub.doc(docId).size,
      'the cache-only op was reconciled into the queue and re-sent',
    ).toBeGreaterThan(0)
  })
})
