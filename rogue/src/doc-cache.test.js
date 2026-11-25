// @ts-check
import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import {
  cacheOp,
  cachedOps,
  cachedRows,
  maxSeqPerReplica,
  rejectedGids,
  addRejectedGid,
  clearDoc,
} from './doc-cache.js'
import * as nodeIdV0 from '@pointyink/serde/node_id_v0'

/** Build a minimal multi_op payload whose first 6 bytes are a node_id_v0.
 *  @param {number} replicaId
 *  @param {number} sequence
 */
function opPayload(replicaId, sequence) {
  const out = new Uint8Array(nodeIdV0.SIZE + 4)
  const view = new DataView(out.buffer)
  nodeIdV0.encode({ replica_id: replicaId, sequence }, view, 0)
  return out
}

/** Decode a payload's group node id back to {replica_id, sequence}.
 *  @param {Uint8Array} payload */
function idOf(payload) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  return nodeIdV0.decode(view, 0)
}

describe('doc-cache', () => {
  it('round-trips ops and returns them in (seq, replica) order', async () => {
    const doc = 'doc-order'
    await cacheOp(doc, opPayload(2, 5))
    await cacheOp(doc, opPayload(1, 10))
    await cacheOp(doc, opPayload(1, 3))

    const ops = await cachedOps(doc)
    expect(ops.map(idOf)).toEqual([
      { replica_id: 1, sequence: 3 },
      { replica_id: 2, sequence: 5 },
      { replica_id: 1, sequence: 10 },
    ])
  })

  it('dedupes re-cached ops (same replica+seq)', async () => {
    const doc = 'doc-dedupe'
    await cacheOp(doc, opPayload(1, 7))
    await cacheOp(doc, opPayload(1, 7))

    expect(await cachedOps(doc)).toHaveLength(1)
  })

  it('scopes ops by docId', async () => {
    await cacheOp('doc-c', opPayload(1, 1))
    await cacheOp('doc-d', opPayload(1, 2))

    const c = await cachedOps('doc-c')
    const d = await cachedOps('doc-d')
    expect(c).toHaveLength(1)
    expect(d).toHaveLength(1)
    expect(idOf(c[0]).sequence).toBe(1)
    expect(idOf(d[0]).sequence).toBe(2)
  })

  it('clearDoc drops one doc without touching others', async () => {
    await cacheOp('doc-e', opPayload(1, 1))
    await cacheOp('doc-f', opPayload(2, 2))

    await clearDoc('doc-e')

    expect(await cachedOps('doc-e')).toHaveLength(0)
    expect(await cachedOps('doc-f')).toHaveLength(1)
  })

  it('ignores a payload too small for a node id', async () => {
    await cacheOp('doc-g', new Uint8Array(4))

    expect(await cachedOps('doc-g')).toHaveLength(0)
  })

  it('records provenance so bootstrap can tell our ops from the server\'s', async () => {
    await cacheOp('doc-own', opPayload(1, 1), { own: true })
    await cacheOp('doc-own', opPayload(2, 1))

    const rows = await cachedRows('doc-own')
    expect(rows.map((r) => r.own)).toEqual([true, false])
  })
})

describe('since (max seq per replica)', () => {
  it('is empty for a fresh doc, so the client asks for everything', async () => {
    expect(await maxSeqPerReplica('since-fresh')).toEqual({})
  })

  it('is the maximum per replica, gaps and all', async () => {
    // `seq` is a Lamport clock: 1, 14, 27 is a normal replica. A contiguous
    // floor can never pass the first gap, which is why `since` is a maximum.
    const doc = 'since-gaps'
    await cacheOp(doc, opPayload(1, 1))
    await cacheOp(doc, opPayload(1, 14))
    await cacheOp(doc, opPayload(1, 27))
    await cacheOp(doc, opPayload(2, 58))

    expect(await maxSeqPerReplica(doc)).toEqual({ 1: 27, 2: 58 })
  })

  it('goes away with the history', async () => {
    const doc = 'since-clear'
    await cacheOp(doc, opPayload(1, 9))
    await clearDoc(doc)
    expect(await maxSeqPerReplica(doc)).toEqual({})
  })
})

describe('rejected ops', () => {
  it('remembers an op this engine cannot render', async () => {
    const doc = 'reject-basic'
    expect(await rejectedGids(doc)).toEqual([])
    await addRejectedGid(doc, '3:42')
    await addRejectedGid(doc, '3:42') // idempotent
    expect(await rejectedGids(doc)).toEqual(['3:42'])
  })

  it('ignores a verdict from an older engine version', async () => {
    // A rejected op is a claim about *this* engine, so a validator fix must get
    // to look at it again rather than keep it hidden for ever.
    const doc = 'reject-versioned'
    await addRejectedGid(doc, '1:1', { version: '0.4.0' })
    expect(await rejectedGids(doc, { version: '0.4.0' })).toEqual(['1:1'])
    expect(await rejectedGids(doc, { version: '0.4.1' })).toEqual([])
  })

  it('applies a verdict regardless of how much the document has grown', async () => {
    // It used to be keyed on the cache size, to re-examine an op invalid alone but
    // valid once later ops arrive. But that size is read while the last cache
    // writes are still in flight, so it is routinely recorded a few short: the
    // verdict never matched, every load walked back again, and each load found one
    // more bad op. Correctness does not need the count (a stale verdict can only
    // hide an op that would now render); re-examining is a separate, cheap job.
    const doc = 'reject-grown'
    await cacheOp(doc, opPayload(1, 1))
    await addRejectedGid(doc, '1:1')
    await cacheOp(doc, opPayload(1, 2))
    await cacheOp(doc, opPayload(1, 3))
    expect(await rejectedGids(doc)).toEqual(['1:1'])
  })

  it('clearDoc drops the verdict with the history', async () => {
    const doc = 'reject-clear'
    await cacheOp(doc, opPayload(1, 1))
    await addRejectedGid(doc, '1:1')
    await clearDoc(doc)
    expect(await rejectedGids(doc)).toEqual([])
  })
})
