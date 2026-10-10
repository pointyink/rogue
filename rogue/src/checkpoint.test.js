// @ts-check
import { describe, it, expect, beforeEach } from 'vitest'
import { advanceWatermark, mergeAndAdvance, appendSince } from './checkpoint.js'
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

describe('advanceWatermark', () => {
  it('advances the max seq per replica', () => {
    /** @type {Record<string, number>} */
    const wm = {}
    advanceWatermark(wm, opPayload(1, 5))
    advanceWatermark(wm, opPayload(2, 10))
    advanceWatermark(wm, opPayload(1, 3)) // lower seq — no-op
    advanceWatermark(wm, opPayload(1, 7)) // higher — advances
    expect(wm).toEqual({ 1: 7, 2: 10 })
  })

  it('tracks a lagging replica independently (no high-water-mark hole)', () => {
    /** @type {Record<string, number>} */
    const wm = { 1: 100 } // we've fully merged replica 1 up to seq 100
    advanceWatermark(wm, opPayload(2, 5)) // replica 2 is way behind
    expect(wm).toEqual({ 1: 100, 2: 5 })
  })

  it('ignores a payload too small for a node id', () => {
    /** @type {Record<string, number>} */
    const wm = {}
    advanceWatermark(wm, new Uint8Array(4))
    expect(wm).toEqual({})
  })
})

describe('mergeAndAdvance', () => {
  it('merges, then advances on success', () => {
    /** @type {Record<string, number>} */
    const wm = {}
    /** @type {Uint8Array[]} */
    const merged = []
    mergeAndAdvance((p) => merged.push(p), wm, opPayload(1, 5))
    expect(merged).toHaveLength(1)
    expect(wm).toEqual({ 1: 5 })
  })

  it('does NOT advance when merge throws', () => {
    /** @type {Record<string, number>} */
    const wm = {}
    expect(() =>
      mergeAndAdvance(
        () => {
          throw new Error('UnknownParent')
        },
        wm,
        opPayload(1, 5),
      ),
    ).toThrow('UnknownParent')
    expect(wm).toEqual({})
  })
})

describe('appendSince', () => {
  it('leaves the URL unchanged for an empty watermark', () => {
    expect(appendSince('wss://sync.example.com/ws/doc-1', {})).toBe('wss://sync.example.com/ws/doc-1')
  })

  it('appends the watermark as ?since=', () => {
    const url = appendSince('wss://sync.example.com/ws/doc-1', { 1: 100, 2: 50 })
    expect(url).toBe(`wss://sync.example.com/ws/doc-1?since=${encodeURIComponent('{"1":100,"2":50}')}`)
  })

  it('uses & when the URL already has a query string', () => {
    const url = appendSince('wss://sync.example.com/ws/doc-1?foo=bar', { 0: 7 })
    expect(url).toBe(`wss://sync.example.com/ws/doc-1?foo=bar&since=${encodeURIComponent('{"0":7}')}`)
  })
})
