// @ts-check
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createDocBus } from './doc-bus.js'

// Minimal BroadcastChannel fake: delivers to other instances (never self),
// async like the real thing.
class FakeBroadcastChannel {
  /** @type {Map<string, Set<FakeBroadcastChannel>>} */
  static channels = new Map()

  /** @param {string} name */
  constructor(name) {
    this.name = name
    /** @type {((e: { data: any }) => void) | null} */
    this.onmessage = null
    let set = FakeBroadcastChannel.channels.get(name)
    if (!set) {
      set = new Set()
      FakeBroadcastChannel.channels.set(name, set)
    }
    set.add(this)
  }

  /** @param {any} data */
  postMessage(data) {
    const peers = FakeBroadcastChannel.channels.get(this.name) || new Set()
    for (const peer of peers) {
      if (peer === this) continue
      queueMicrotask(() => peer.onmessage?.({ data }))
    }
  }

  close() {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this)
  }

  static reset() {
    FakeBroadcastChannel.channels = new Map()
  }
}

const DOC = 'doc-1'
const CHANNEL = `rogue:doc:${DOC}`

beforeEach(() => {
  FakeBroadcastChannel.reset()
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Flush microtasks. */
const tick = () => Promise.resolve()

describe('createDocBus', () => {
  it('broadcasts an op to siblings', async () => {
    const bus = createDocBus({ docId: DOC, onOp: () => {} })
    const peer = new FakeBroadcastChannel(CHANNEL)
    /** @type {any[]} */
    const got = []
    peer.onmessage = (e) => got.push(e.data)

    const payload = new Uint8Array([1, 2, 3])
    bus.broadcastOp(payload)

    await tick()
    await tick()
    expect(got).toEqual([{ type: 'op', payload }])
    bus.destroy()
  })

  it('merges a sibling op via onOp', async () => {
    /** @type {Uint8Array[]} */
    const ops = []
    const bus = createDocBus({ docId: DOC, onOp: (p) => ops.push(p) })

    const peer = new FakeBroadcastChannel(CHANNEL)
    const payload = new Uint8Array([7, 8])
    peer.postMessage({ type: 'op', payload })

    await tick()
    await tick()
    expect(ops).toEqual([payload])
    bus.destroy()
  })

  it('ignores non-op messages', async () => {
    /** @type {Uint8Array[]} */
    const ops = []
    const bus = createDocBus({ docId: DOC, onOp: (p) => ops.push(p) })

    const peer = new FakeBroadcastChannel(CHANNEL)
    peer.postMessage({ type: 'other', payload: new Uint8Array([1]) })

    await tick()
    await tick()
    expect(ops).toEqual([])
    bus.destroy()
  })

  it('does not deliver to itself', async () => {
    /** @type {Uint8Array[]} */
    const ops = []
    const bus = createDocBus({ docId: DOC, onOp: (p) => ops.push(p) })

    bus.broadcastOp(new Uint8Array([9]))

    await tick()
    await tick()
    expect(ops).toEqual([])
    bus.destroy()
  })
})
