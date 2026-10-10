// @ts-check
import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { cacheOp, cachedOps, clearDoc } from './doc-cache.js'
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
})
