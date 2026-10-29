// @ts-check
//
// Observability surface: node.stats() / getString() / exportOps() /
// assertConsistent(), the soft sizeWarn hook, and oplog.pendingCount().
//
// The point of these hooks is the "Nobody Owns HTML" incident: a host needs to
// notice a doc is pathological and get the content out, without the engine
// leaking crdt/rope internals or the host re-deriving sizes from the DOM.

import 'fake-indexeddb/auto'
import { describe, it, expect, vi } from 'vitest'
import { createRogueNode } from './sync.js'
import { enqueue, ackMany, pendingCount } from './oplog.js'

const flush = () => new Promise((r) => setTimeout(r, 0))

/** @returns {HTMLElement} */
function editor() {
  const e = document.createElement('div')
  e.setAttribute('contenteditable', 'true')
  document.body.appendChild(e)
  return e
}

/** @param {Node} n @returns {Text | null} */
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

describe('node.stats()', () => {
  it('reports an empty doc as empty', async () => {
    const n = await createRogueNode({ element: editor(), replicaId: 1 })
    expect(n.stats()).toMatchObject({
      visLen: 0,
      ops: 0,
      opBytes: 0,
      parked: 0,
      parkedDropped: 0,
    })
    // The arena always holds its initial capacity, so this is never 0 — it is
    // allocated memory, not content. Assert it is a real number, not NaN.
    expect(n.stats().crdtBytes).toBeGreaterThan(0)
  })

  it('tracks applied ops and their payload bytes', async () => {
    /** @type {Uint8Array[]} */
    const committed = []
    const el = editor()
    const n = await createRogueNode({
      element: el,
      replicaId: 2,
      onCommit: (p) => committed.push(p),
    })

    el.innerHTML = '<p>hello</p>'
    await flush()
    el.innerHTML = '<p>hello world</p>'
    await flush()

    const s = n.stats()
    expect(s.ops).toBe(committed.length)
    expect(s.opBytes).toBe(committed.reduce((sum, p) => sum + p.byteLength, 0))
    expect(s.visLen).toBe('<p>hello world</p>'.length)
  })

  it('grows crdtBytes with the document (it is not the static reservation)', async () => {
    const el = editor()
    const n = await createRogueNode({ element: el, replicaId: 3 })
    const empty = n.stats().crdtBytes

    el.innerHTML = '<p>' + 'x'.repeat(200_000) + '</p>'
    await flush()

    // 200k chars blows past the arena's initial capacity: the number must move.
    expect(n.stats().crdtBytes).toBeGreaterThan(empty)
  })

  it('parks ops whose dependency is missing, then drains them', async () => {
    const elA = editor()
    const elB = editor()
    /** @type {Uint8Array[]} */
    const fromB = []

    const A = await createRogueNode({ element: elA, replicaId: 4 })
    const B = await createRogueNode({
      element: elB,
      replicaId: 5,
      onCommit: (p) => fromB.push(p),
    })

    elB.innerHTML = '<p>hello</p>'
    await flush()
    const t = /** @type {Text} */ (firstText(/** @type {Element} */ (elB.querySelector('p'))))
    t.data = 'hello world'
    await flush()
    expect(fromB.length).toBe(2)

    // Deliver the dependent op first: its parent char only exists in `fromB[0]`.
    A.mergeOp(fromB[1])
    expect(A.stats().parked).toBe(1)
    expect(A.getString()).toBe('')

    A.mergeOp(fromB[0])
    expect(A.stats().parked).toBe(0)
    expect(A.getString()).toBe('<p>hello world</p>')
  })
})

describe('node.getString()', () => {
  it('returns the current value and round-trips into a fresh node', async () => {
    const elA = editor()
    const A = await createRogueNode({ element: elA, replicaId: 6 })
    elA.innerHTML = '<p>one</p><ul><li>two</li></ul>'
    await flush()

    const html = A.getString()
    expect(html).toBe('<p>one</p><ul><li>two</li></ul>')

    const elB = editor()
    const B = await createRogueNode({ element: elB, replicaId: 7 })
    elB.innerHTML = html
    await flush()
    expect(B.getString()).toBe(html)
  })
})

describe('node.exportOps()', () => {
  it('exports every applied payload, and they rebuild the doc', async () => {
    const elA = editor()
    const A = await createRogueNode({ element: elA, replicaId: 8 })
    elA.innerHTML = '<p>alpha</p>'
    await flush()
    elA.innerHTML = '<p>alpha beta</p>'
    await flush()

    const ops = A.exportOps()
    expect(ops.length).toBe(A.stats().ops)
    for (const { gid, payload } of ops) {
      expect(typeof gid.replica).toBe('number')
      expect(typeof gid.seq).toBe('number')
      expect(payload).toBeInstanceOf(Uint8Array)
    }

    const elC = editor()
    const C = await createRogueNode({ element: elC, replicaId: 9 })
    for (const { payload } of ops) C.mergeOp(payload)
    expect(C.getString()).toBe(A.getString())
  })
})

describe('node.assertConsistent()', () => {
  it('reports ok when the CRDT and DOM agree', async () => {
    const el = editor()
    const n = await createRogueNode({ element: el, replicaId: 10 })
    el.innerHTML = '<p>consistent</p>'
    await flush()

    const report = n.assertConsistent()
    expect(report.ok).toBe(true)
    expect(report.crdt).toBe(n.getString())
    expect(report.crdt).toBe(report.dom)
  })
})

describe('sizeWarn / onSizeWarning', () => {
  it('fires once when a metric first crosses its threshold', async () => {
    const el = editor()
    /** @type {{ key: string, ops: number }[]} */
    const warnings = []
    const n = await createRogueNode({
      element: el,
      replicaId: 11,
      sizeWarn: { ops: 2 },
      onSizeWarning: (stats, key) => warnings.push({ key, ops: stats.ops }),
    })

    el.innerHTML = '<p>a</p>'
    await flush()
    expect(warnings).toHaveLength(0) // 1 op, below the threshold

    el.innerHTML = '<p>ab</p>'
    await flush()
    expect(warnings).toEqual([{ key: 'ops', ops: 2 }])

    el.innerHTML = '<p>abc</p>'
    await flush()
    expect(warnings).toHaveLength(1) // already armed: no repeat
  })

  it('does nothing when sizeWarn is unset', async () => {
    const el = editor()
    const onSizeWarning = vi.fn()
    const n = await createRogueNode({ element: el, replicaId: 12, onSizeWarning })
    el.innerHTML = '<p>' + 'x'.repeat(50_000) + '</p>'
    await flush()
    expect(n.stats().ops).toBeGreaterThan(0)
    expect(onSizeWarning).not.toHaveBeenCalled()
  })
})

describe('oplog.pendingCount()', () => {
  it('counts unacked ops without materializing them', async () => {
    const docId = 'pending-count-' + Math.random().toString(36).slice(2)
    expect(await pendingCount(docId)).toBe(0)

    await enqueue(docId, '1:1', new Uint8Array([1, 2, 3]))
    await enqueue(docId, '1:2', new Uint8Array([4, 5, 6]))
    await enqueue('other-doc', '1:1', new Uint8Array([7]))
    expect(await pendingCount(docId)).toBe(2)

    await ackMany(docId, ['1:1'])
    expect(await pendingCount(docId)).toBe(1)
  })
})
