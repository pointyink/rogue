// @ts-check
//
// One node, many authors: `node.setAuthor(id)` lets a single replica emit ops
// under several replica ids — a shared server-side replica multiplexing agent
// connections, where each connection gets its own author identity.

import { describe, it, expect } from 'vitest'
import { createRogueNode } from './sync.js'

const flush = () => new Promise((r) => setTimeout(r, 0))

/** @returns {HTMLElement} */
function editor() {
  const e = document.createElement('div')
  e.setAttribute('contenteditable', 'true')
  document.body.appendChild(e)
  return e
}

/** First text node under `n`, depth-first. @param {Node} n @returns {Text | null} */
function firstText(n) {
  for (const c of n.childNodes) {
    if (c.nodeType === 3) return /** @type {Text} */ (c)
    if (c.nodeType === 1) {
      const r = firstText(c)
      if (r) return r
    }
  }
  return null
}

/** Group node id (first 6 bytes) of a multi_op_v0 payload. @param {Uint8Array} p */
function groupId(p) {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength)
  return { replica_id: dv.getUint16(0, true), sequence: dv.getUint32(2, true) }
}

describe('multi-author replica', () => {
  it('stamps ops under each author id and peers converge', async () => {
    const el = editor()
    /** @type {Uint8Array[]} */ const ops = []
    const node = await createRogueNode({ element: el, replicaId: 1, onCommit: (p) => ops.push(p) })

    // Author 1 writes.
    el.innerHTML = '<p>one</p>'
    await flush()
    expect(ops.length).toBeGreaterThan(0)

    // Switch to author 2 (a second agent connection) and write more.
    node.setAuthor(2)
    const t = firstText(el)
    if (!t) throw new Error('no text node')
    t.data = 'one two'
    await flush()

    const ids = ops.map(groupId)
    expect(ids[0].replica_id).toBe(1)
    expect(ids[ids.length - 1].replica_id).toBe(2)
    // Unique across authors: no reuse, no collision.
    const keys = ids.map((g) => `${g.replica_id}:${g.sequence}`)
    expect(new Set(keys).size).toBe(keys.length)

    // Author 2's first sequence is seeded past author 1's, so it sorts last.
    const a2 = ids.find((g) => g.replica_id === 2)
    expect(a2).toBeDefined()
    expect(/** @type {any} */ (a2).sequence).toBeGreaterThan(ids[0].sequence)

    // A peer converges on the same content, merging one batch per author.
    const el2 = editor()
    const peer = await createRogueNode({ element: el2, replicaId: 9 })
    for (const op of ops) peer.mergeOp(op)
    await flush()
    expect(el2.textContent).toBe('one two')
    expect(el2.innerHTML).toBe(el.innerHTML)
  })

  it('switching back to an author keeps its counter monotonic', async () => {
    const el = editor()
    /** @type {Uint8Array[]} */ const ops = []
    const node = await createRogueNode({ element: el, replicaId: 1, onCommit: (p) => ops.push(p) })

    el.innerHTML = '<p>a</p>'
    await flush()
    node.setAuthor(2)
    const t = firstText(el)
    if (!t) throw new Error('no text node')
    t.data = 'ab'
    await flush()
    node.setAuthor(1)
    t.data = 'abc'
    await flush()

    const author1 = ops.filter((p) => groupId(p).replica_id === 1).map((p) => groupId(p).sequence)
    expect(author1.length).toBeGreaterThanOrEqual(2)
    // Monotonic per author — never rewinds when switching back.
    for (let i = 1; i < author1.length; i++) {
      expect(author1[i]).toBeGreaterThan(author1[i - 1])
    }
  })
})
