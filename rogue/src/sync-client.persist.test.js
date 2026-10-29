// @ts-check
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createSyncClient } from './sync-client.js'
import { cacheOp, cachedOps } from './doc-cache.js'

// No IndexedDB in this file: both stores are mocked so the test can assert
// whether the sync client *chose* to persist.
vi.mock('./oplog.js', () => ({
  enqueue: vi.fn(() => Promise.resolve()),
  ackMany: vi.fn(() => Promise.resolve()),
  pendingFor: vi.fn(() => Promise.resolve([])),
  pendingCount: vi.fn(() => Promise.resolve(0)),
  clearDoc: vi.fn(() => Promise.resolve()),
}))
vi.mock('./doc-cache.js', () => ({
  cacheOp: vi.fn(() => Promise.resolve()),
  cachedOps: vi.fn(() => Promise.resolve([])),
  clearDoc: vi.fn(() => Promise.resolve()),
}))

class FakeWebSocket {
  /** @type {FakeWebSocket[]} */
  static instances = []
  /** @type {Record<string, ((e: any) => void)[]>} */
  listeners = {}

  /** @param {string} url @param {string[]} protocols */
  constructor(url, protocols) {
    this.url = url
    this.protocols = protocols
    FakeWebSocket.instances.push(this)
  }

  /** @param {string} type @param {(e: any) => void} fn */
  addEventListener(type, fn) {
    ;(this.listeners[type] ||= []).push(fn)
  }

  send() {}
  close() {}

  /** @param {any} data */
  emitMessage(data) {
    for (const fn of this.listeners.message || []) fn({ data })
  }
}

/** [disc u16][len u32][payload]
 *  @param {number} disc @param {Uint8Array} payload */
function frame(disc, payload) {
  const out = new Uint8Array(6 + payload.length)
  const view = new DataView(out.buffer)
  view.setUint16(0, disc, true)
  view.setUint32(2, payload.length, true)
  out.set(payload, 6)
  return out.buffer
}

/** @param {number} replicaId @param {number} sequence @returns {Uint8Array} */
function opPayload(replicaId, sequence) {
  const out = new Uint8Array(10)
  const view = new DataView(out.buffer)
  view.setUint16(0, replicaId, true)
  view.setUint32(2, sequence, true)
  return out
}

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.clearAllMocks()
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createSyncClient persist option', () => {
  it('skips the doc cache entirely when persist is false', async () => {
    createSyncClient({
      wsUrl: 'wss://sync.example.com/ws/doc-1',
      docId: 'doc-1',
      mergeOp: () => {},
      getToken: () => Promise.resolve('token-1'),
      persist: false,
    })

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    // Bootstrap must not read the cache.
    expect(cachedOps).not.toHaveBeenCalled()

    FakeWebSocket.instances[0].emitMessage(frame(3, opPayload(1, 1)))
    await new Promise((r) => setTimeout(r, 0))
    // Nor write every merged op.
    expect(cacheOp).not.toHaveBeenCalled()
  })

  it('persists by default (browser/offline behavior unchanged)', async () => {
    createSyncClient({
      wsUrl: 'wss://sync.example.com/ws/doc-1',
      docId: 'doc-1',
      mergeOp: () => {},
      getToken: () => Promise.resolve('token-1'),
    })

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    expect(cachedOps).toHaveBeenCalled()

    FakeWebSocket.instances[0].emitMessage(frame(3, opPayload(1, 1)))
    await vi.waitFor(() => expect(cacheOp).toHaveBeenCalled())
  })
})
