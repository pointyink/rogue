// @ts-check
//
// Wrap-in-place formatting tests. A formatting edit (bold a word, italic a word)
// must emit *insert-only* ops — the tag characters are inserted at the range
// boundaries and the text is never deleted — so concurrent formatting composes
// instead of duplicating.
//
// These decode the emitted multi_op_v0 payloads to assert the op *shape*
// (insert-only for formatting, hide for text deletion), and run a two-replica
// concurrent bold/italic scenario to assert convergence with no duplication.

import { describe, it, expect } from 'vitest'
import { createRogueNode } from './sync.js'
import * as multiOpV0 from '../../serde/multi_op_v0.js'
import * as hideV0 from '../../serde/hide_v0.js'
import * as showV0 from '../../serde/show_v0.js'
import * as insertV0 from '../../serde/insert_v0.js'

const flush = () => new Promise((r) => setTimeout(r, 0))

/** @returns {HTMLElement} */
function makeEditor() {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  document.body.appendChild(el)
  return el
}

/** @param {HTMLElement} el @param {string} html */
async function type(el, html) {
  el.innerHTML = html
  await flush()
}

/** First text node under a subtree (depth-first). @param {Node} n @returns {Text | null} */
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

/**
 * Wrap chars [from, to) of the first text node in a `<tag>`, *in place* (split
 * + replaceWith) — a scoped structural change the observer localizes, unlike a
 * whole-innerHTML replacement.
 * @param {HTMLElement} el @param {number} from @param {number} to @param {string} tag
 */
function wrapRange(el, from, to, tag) {
  const t = firstText(el)
  if (!t) throw new Error('no text node')
  const rest = t.splitText(from)
  const mid = rest.splitText(to - from)
  const span = document.createElement(tag)
  span.textContent = rest.data
  rest.replaceWith(span)
  return mid
}

/** @param {Uint16Array} chars */
function u16ToString(chars) {
  let s = ''
  for (const c of chars) s += String.fromCharCode(c)
  return s
}

/**
 * Decode a multi_op_v0 payload into friendly `{ type, len, text?, target? }`
 * entries so tests can assert on op shape (insert-only vs hide).
 * @param {Uint8Array} payload
 */
function decodeOps(payload) {
  const { ops } = multiOpV0.decode(payload)
  return ops.map(({ disc, payload: p }) => {
    if (disc === hideV0.DISC) {
      const h = hideV0.decode(p)
      return { type: 'hide', len: h.len, target: h.target }
    }
    if (disc === showV0.DISC) {
      const s = showV0.decode(p)
      return { type: 'show', len: s.len, target: s.target }
    }
    if (disc === insertV0.DISC) {
      const ins = insertV0.decode(p)
      return { type: 'insert', len: ins.chars.length, text: u16ToString(ins.chars) }
    }
    return { type: `disc${disc}`, len: 0 }
  })
}

describe('wrap-in-place formatting', () => {
  it('a scoped formatting edit emits insert-only ops (no delete)', async () => {
    const el = makeEditor()
    /** @type {Uint8Array[]} */
    const ops = []
    const node = await createRogueNode({ element: el, onCommit: (p) => ops.push(p) })
    const rogue = /** @type {any} */ (window).rogue
    try {
      await type(el, '<p>hello world</p>')
      const before = ops.length

      // Bold "hello" via an in-place DOM wrap — a structural change.
      wrapRange(el, 0, 5, 'b')
      await flush()

      expect(ops.length).toBe(before + 1)
      const decoded = decodeOps(ops[ops.length - 1])
      // Wrap-in-place: the tags are inserted at the boundaries, nothing deleted.
      expect(decoded.map((o) => o.type)).toEqual(['insert', 'insert'])
      expect(decoded[0].text).toBe('<b>')
      expect(decoded[1].text).toBe('</b>')
      expect(rogue.render()).toBe('<p><b>hello</b> world</p>')
      expect(el.innerHTML).toBe(rogue.render())
    } finally {
      node.destroy()
      el.remove()
    }
  })

  it('a text-only edit emits a hide (no tag insert)', async () => {
    const el = makeEditor()
    /** @type {Uint8Array[]} */
    const ops = []
    const node = await createRogueNode({ element: el, onCommit: (p) => ops.push(p) })
    const rogue = /** @type {any} */ (window).rogue
    try {
      await type(el, '<p>hello world</p>')
      const before = ops.length

      // Delete one 'l' ("hello" → "helo") via an in-place text mutation.
      const t = firstText(el)
      if (!t) throw new Error('no text node')
      t.data = t.data.slice(0, 3) + t.data.slice(4)
      await flush()

      expect(ops.length).toBe(before + 1)
      const decoded = decodeOps(ops[ops.length - 1])
      expect(decoded.map((o) => o.type)).toEqual(['hide'])
      expect(decoded[0].len).toBe(1)
      expect(rogue.render()).toBe('<p>helo world</p>')
    } finally {
      node.destroy()
      el.remove()
    }
  })

  it('concurrent bold + italic converge with no duplication', async () => {
    const a = makeEditor()
    const b = makeEditor()

    /** @type {import('./sync.js').RogueNode | null} */
    let nodeA = null
    /** @type {import('./sync.js').RogueNode | null} */
    let nodeB = null
    /** @type {Uint8Array[]} */
    const inboxA = []
    /** @type {Uint8Array[]} */
    const inboxB = []

    nodeA = await createRogueNode({ element: a, onCommit: (p) => inboxB.push(p) })
    /** @type {any} */
    const rogueA = /** @type {any} */ (window).rogue
    nodeB = await createRogueNode({ element: b, onCommit: (p) => inboxA.push(p) })
    /** @type {any} */
    const rogueB = /** @type {any} */ (window).rogue

    /** Deliver all buffered ops both ways (A's ops → B, B's ops → A). */
    function deliverAll() {
      for (const p of inboxB.splice(0)) nodeB?.mergeOp(p)
      for (const p of inboxA.splice(0)) nodeA?.mergeOp(p)
    }

    try {
      // Seed both replicas identically, and sync the seed.
      await type(a, '<p>hello world</p>')
      deliverAll()
      expect(b.innerHTML).toBe('<p>hello world</p>')

      // Concurrent edits: A bolds "hello", B italicizes "world" — each against
      // the pre-edit state, before either sees the other's op.
      wrapRange(a, 0, 5, 'b')
      await flush()
      wrapRange(b, 6, 11, 'i')
      await flush()
      expect(inboxB).toHaveLength(1) // A's bold op, buffered
      expect(inboxA).toHaveLength(1) // B's italic op, buffered

      // Both edits are insert-only (wrap-in-place).
      expect(decodeOps(inboxB[0]).map((o) => o.type)).toEqual(['insert', 'insert'])
      expect(decodeOps(inboxA[0]).map((o) => o.type)).toEqual(['insert', 'insert'])

      // Deliver and settle.
      deliverAll()
      await flush()

      // Both tags land, in order, with no duplication of the text.
      expect(a.innerHTML).toBe('<p><b>hello</b> <i>world</i></p>')
      expect(b.innerHTML).toBe(a.innerHTML)
      expect(rogueA.render()).toBe(a.innerHTML)
      expect(rogueB.render()).toBe(b.innerHTML)
    } finally {
      nodeA?.destroy()
      nodeB?.destroy()
      a.remove()
      b.remove()
    }
  })

  it('concurrent links on the same range: the second is rejected (no <a><a>)', async () => {
    const a = makeEditor()
    const b = makeEditor()

    /** @type {import('./sync.js').RogueNode | null} */
    let nodeA = null
    /** @type {import('./sync.js').RogueNode | null} */
    let nodeB = null
    /** @type {Uint8Array[]} */
    const inboxA = []
    /** @type {Uint8Array[]} */
    const inboxB = []

    nodeA = await createRogueNode({ element: a, onCommit: (p) => inboxB.push(p) })
    /** @type {any} */
    const rogueA = /** @type {any} */ (window).rogue
    nodeB = await createRogueNode({ element: b, onCommit: (p) => inboxA.push(p) })
    /** @type {any} */
    const rogueB = /** @type {any} */ (window).rogue

    function deliverAll() {
      for (const p of inboxB.splice(0)) nodeB?.mergeOp(p)
      for (const p of inboxA.splice(0)) nodeA?.mergeOp(p)
    }

    try {
      await type(a, '<p>hello world</p>')
      deliverAll()
      expect(b.innerHTML).toBe('<p>hello world</p>')

      // Concurrent: both wrap "hello" in a link. A link can't nest in a link, so
      // whichever lands second produces <a><a>, breaks round-trip, and is rejected.
      wrapRange(a, 0, 5, 'a')
      await flush()
      wrapRange(b, 0, 5, 'a')
      await flush()

      deliverAll()
      await flush()

      // One link survives on each side; no nested <a><a>.
      expect(a.innerHTML).toBe('<p><a>hello</a> world</p>')
      expect(b.innerHTML).toBe(a.innerHTML)
      expect(rogueA.render()).toBe(a.innerHTML)
      expect(rogueB.render()).toBe(b.innerHTML)
    } finally {
      nodeA?.destroy()
      nodeB?.destroy()
      a.remove()
      b.remove()
    }
  })

  it('concurrent overlapping bold + italic converge via the fold (no crossed tags)', async () => {
    const a = makeEditor()
    const b = makeEditor()

    /** @type {import('./sync.js').RogueNode | null} */
    let nodeA = null
    /** @type {import('./sync.js').RogueNode | null} */
    let nodeB = null
    /** @type {Uint8Array[]} */
    const inboxA = []
    /** @type {Uint8Array[]} */
    const inboxB = []

    nodeA = await createRogueNode({ element: a, onCommit: (p) => inboxB.push(p) })
    /** @type {any} */
    const rogueA = /** @type {any} */ (window).rogue
    nodeB = await createRogueNode({ element: b, onCommit: (p) => inboxA.push(p) })
    /** @type {any} */
    const rogueB = /** @type {any} */ (window).rogue

    function deliverAll() {
      for (const p of inboxB.splice(0)) nodeB?.mergeOp(p)
      for (const p of inboxA.splice(0)) nodeA?.mergeOp(p)
    }

    try {
      await type(a, '<p>abcdefghijklmno</p>')
      deliverAll()
      expect(b.innerHTML).toBe('<p>abcdefghijklmno</p>')

      // A bolds [0,10], B italicizes [5,15] — partial overlap. If both applied,
      // the tags cross (<b>…<i>…</b>…</i>) and break the round-trip, so the fold
      // rejects the loser by (seq, replica) order.
      wrapRange(a, 0, 10, 'b')
      await flush()
      wrapRange(b, 5, 15, 'i')
      await flush()

      deliverAll()
      await flush()

      // Both converge to the same winner, with exactly one of the two tags.
      expect(a.innerHTML).toBe(b.innerHTML)
      expect(rogueA.render()).toBe(a.innerHTML)
      expect(rogueB.render()).toBe(b.innerHTML)
      const hasB = a.innerHTML.includes('<b>')
      const hasI = a.innerHTML.includes('<i>')
      expect(hasB !== hasI).toBe(true) // exactly one survived, never both
    } finally {
      nodeA?.destroy()
      nodeB?.destroy()
      a.remove()
      b.remove()
    }
  })

  it('a table with superscript survives an op replay (reload)', async () => {
    const a = makeEditor()
    /** @type {Uint8Array[]} */
    const ops = []
    const nodeA = await createRogueNode({ element: a, onCommit: (p) => ops.push(p) })

    await type(a, '<table><tbody><tr><td>x</td></tr></tbody></table>')
    await type(a, '<table><tbody><tr><td>x<sup>2</sup></td></tr></tbody></table>')

    // Replay every op into a fresh node — the reload path (opSync + round-trip check).
    const b = makeEditor()
    const nodeB = await createRogueNode({ element: b })
    for (const p of ops) nodeB.mergeOp(p)
    await flush()

    const expected = '<table><tbody><tr><td>x<sup>2</sup></td></tr></tbody></table>'
    expect(b.innerHTML).toBe(expected)

    nodeA.destroy()
    nodeB.destroy()
    a.remove()
    b.remove()
  })
})
