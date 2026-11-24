// @ts-check
//
// The doc-cache opens its IndexedDB once per page and reuses the connection.
// That sounds obvious, but 0.4.2 shipped without assigning the cached promise:
// every `cacheOp` (i.e. every op, every keystroke) opened a *new* connection and
// none were ever closed. This file exists so a regression is one test away —
// it needs its own module instance, hence its own file.
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'

/** @param {number} replica @param {number} seq */
function opPayload(replica, seq) {
  const out = new Uint8Array(10)
  const view = new DataView(out.buffer)
  view.setUint16(0, replica, true)
  view.setUint32(2, seq, true)
  return out
}

describe('doc-cache connection', () => {
  it('opens once and reuses the connection across calls', async () => {
    const open = vi.spyOn(indexedDB, 'open')
    const { cacheOp, cachedOps, confirmedFloors } = await import('./doc-cache.js')

    await cacheOp('reuse', opPayload(1, 1))
    await cachedOps('reuse')
    await confirmedFloors('reuse')
    await cacheOp('reuse', opPayload(1, 2))

    expect(open).toHaveBeenCalledTimes(1)
  })
})
