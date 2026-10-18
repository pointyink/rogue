// @ts-check
//
// Malformed / conflicting op table — the load-bearing regression suite for the
// render+validate path in sync.js.
//
// These construct *remote* ops (multi_op_v0 payloads with raw `<`/`>` chars, or
// hides of tag chars) and feed them through `mergeOp`, exercising the reject /
// escalate logic that only runs on the network path (the local path diffs the
// DOM, which the browser already parsed, so it can't produce malformed HTML).
//
// Each malformed case asserts the op is *rejected* (the CRDT reverts and the DOM
// stays valid + consistent with the CRDT render). Each wide-effect case asserts
// the op is *applied* and the doc stays consistent (CRDT ≡ DOM ≡ rope).

import { describe, it, expect } from 'vitest'
import { createRogueNode } from './sync.js'
import { assertConsistent } from './fuzz-helpers.js'
import * as multiOpV0 from '@pointyink/serde/multi_op_v0'
import * as insertV0 from '@pointyink/serde/insert_v0'
import * as insertBytesV0 from '@pointyink/serde/insert_bytes_v0'
import * as hideV0 from '@pointyink/serde/hide_v0'

/** @returns {HTMLElement} */
function makeEditor() {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  document.body.appendChild(el)
  return el
}

const flush = () => new Promise((r) => setTimeout(r, 0))

/** Simulate a user edit through the local path. @param {HTMLElement} el @param {string} html */
async function type(el, html) {
  el.innerHTML = html
  await flush()
}

/** "r:s" → { replica_id, sequence }. @param {string} s */
function parseId(s) {
  const [r, seq] = s.split(':')
  return { replica_id: Number(r), sequence: Number(seq) }
}

/** @param {string} s @returns {number[]} */
function utf16(s) {
  return Array.from(s, (c) => c.charCodeAt(0))
}

/** Insert `text` at position `visIx` (just before the node currently there).
 *  Uses Side.Left of the node at `visIx` so a high-seq insert interleaves to the
 *  spot rather than to the end of the parent's right-run.
 *  @param {any} rogue
 *  @param {{replica_id:number, sequence:number}} id
 *  @param {number} visIx
 *  @param {string} text */
function insertAt(rogue, id, visIx, text) {
  const parent = parseId(rogue.idAt(visIx))
  return {
    disc: insertV0.DISC,
    payload: insertV0.encode(id, parent, insertV0.Side.Left, utf16(text)),
  }
}

/** Hide `len` chars starting at visIx.
 *  @param {any} rogue
 *  @param {{replica_id:number, sequence:number}} id
 *  @param {number} visIx
 *  @param {number} len */
function hideAt(rogue, id, visIx, len) {
  const target = parseId(rogue.idAt(visIx))
  return {
    disc: hideV0.DISC,
    payload: hideV0.encode({ id, target, len }),
  }
}

/** @param {{replica_id:number, sequence:number}} groupId @param {any[]} ops */
function multiOp(groupId, ops) {
  return multiOpV0.encode(groupId, ops)
}

// A fresh, high replica id + seq so the injected op lands at-head.
let opCounter = 0
/** @returns {{replica_id:number, sequence:number}} */
function freshId() {
  opCounter += 1
  return { replica_id: 2, sequence: 1000 + opCounter }
}

/**
 * Set up a node with initial content via the local path, then return the node,
 * the editor element, and the debug API (window.rogue).
 * @param {string} initialHtml
 */
async function setup(initialHtml) {
  const el = makeEditor()
  const node = await createRogueNode({ element: el, replicaId: 1 })
  await type(el, initialHtml)
  const rogue = /** @type {any} */ (window).rogue
  return { node, el, rogue }
}

describe('malformed / conflicting remote ops', () => {
  it('rejects block-in-<p> (inserts a raw <div> inside a <p>)', async () => {
    const { node, el, rogue } = await setup('<p>hello world</p>')
    // "<p>hello" → "<p>hello<div> world</p>" — the div sits inside the p.
    const id = freshId()
    const payload = multiOp(id, [insertAt(rogue, id, 8, '<div>')])
    node.mergeOp(payload)

    expect(el.innerHTML).toBe('<p>hello world</p>')
    expect(rogue.render()).toBe('<p>hello world</p>')
    assertConsistent('block-in-p rejected', el, rogue)
  })

  it('rejects a byte insert (disc 6) in an HTML doc', async () => {
    const el = makeEditor()
    /** @type {any} */
    let caught = null
    const node = await createRogueNode({
      element: el,
      replicaId: 1,
      onError: (e) => {
        caught = e
      },
    })
    await type(el, '<p>hello</p>')
    const rogue = /** @type {any} */ (window).rogue
    const id = freshId()

    // insert_bytes_v0 is the byte-native op; the u16 engine must reject it.
    const payload = multiOp(id, [
      {
        disc: insertBytesV0.DISC,
        payload: insertBytesV0.encode(
          id,
          { replica_id: 0, sequence: 0 },
          insertBytesV0.Side.Root,
          new Uint8Array([0xde, 0xad]),
        ),
      },
    ])
    node.mergeOp(payload)
    await flush()

    expect(caught).toBeTruthy()
    expect(el.innerHTML).toBe('<p>hello</p>')
    expect(rogue.render()).toBe('<p>hello</p>')
    assertConsistent('byte op rejected', el, rogue)
  })

  it('rejects a stray </p> that unbalances a block', async () => {
    const { node, el, rogue } = await setup('<p>hello world</p>')
    // Insert "</p>" after "hello" → a stray close tag mid-block.
    const id = freshId()
    const payload = multiOp(id, [insertAt(rogue, id, 8, '</p>')])
    node.mergeOp(payload)

    expect(el.innerHTML).toBe('<p>hello world</p>')
    expect(rogue.render()).toBe('<p>hello world</p>')
    assertConsistent('stray </p> rejected', el, rogue)
  })

  it('rejects an orphan <td> (table internals outside a table)', async () => {
    const { node, el, rogue } = await setup('<p>hello world</p>')
    const id = freshId()
    const payload = multiOp(id, [insertAt(rogue, id, 8, '<td>cell</td>')])
    node.mergeOp(payload)

    expect(el.innerHTML).toBe('<p>hello world</p>')
    expect(rogue.render()).toBe('<p>hello world</p>')
    assertConsistent('orphan <td> rejected', el, rogue)
  })

  it('rejects a hide of a tag char that unbalances a far opener', async () => {
    // <b>bold</b> — hide the ">" of "</b>" leaves the <b> unclosed.
    const { node, el, rogue } = await setup('<p>a <b>bold</b> c</p>')
    // chars: < p > a ' ' < b > b o l d < / b > ' ' c < / p >
    // visIx: 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19
    // The ">" of "</b>" is at visIx 15.
    const id = freshId()
    const payload = multiOp(id, [hideAt(rogue, id, 15, 1)])
    node.mergeOp(payload)

    expect(el.innerHTML).toBe('<p>a <b>bold</b> c</p>')
    expect(rogue.render()).toBe('<p>a <b>bold</b> c</p>')
    assertConsistent('hide of tag char rejected', el, rogue)
  })

  it('rejects a stray < (bare angle bracket that starts a phantom tag)', async () => {
    const { node, el, rogue } = await setup('<p>hello world</p>')
    // "<b" (open bracket + letter) after "hello" → phantom open tag.
    const id = freshId()
    const payload = multiOp(id, [insertAt(rogue, id, 8, '<b')])
    node.mergeOp(payload)

    expect(el.innerHTML).toBe('<p>hello world</p>')
    expect(rogue.render()).toBe('<p>hello world</p>')
    assertConsistent('stray < rejected', el, rogue)
  })

  it('drops a malformed group (group_id ≠ op id) without corrupting the doc', async () => {
    const { node, el, rogue } = await setup('<p>hello world</p>')
    // A group whose group_id doesn't match its op (the engine always emits
    // group_id == op id for a single-op group). merge() validates this and the
    // op is dropped rather than applied-then-un-revertable.
    const opId = freshId()
    const badGroupId = freshId() // ≠ opId → InvalidGroup
    const inner = {
      disc: insertV0.DISC,
      payload: insertV0.encode(
        opId,
        parseId(rogue.idAt(8)),
        insertV0.Side.Left,
        utf16('<div>'),
      ),
    }
    node.mergeOp(multiOp(badGroupId, [inner]))

    expect(el.innerHTML).toBe('<p>hello world</p>')
    expect(rogue.render()).toBe('<p>hello world</p>')
    assertConsistent('malformed group dropped', el, rogue)
  })
})

/**
 * Two nodes, A's commits gossiped to B. Returns both editors, nodes, and debug
 * APIs so a wide-effect local edit on A can be delivered to B over the remote
 * render path (renderOp) and oracled.
 */
async function setupPair() {
  const elA = makeEditor()
  const elB = makeEditor()
  /** @type {Uint8Array[]} */
  const pendingA = []
  const nodeA = await createRogueNode({ element: elA, replicaId: 1, onCommit: (p) => pendingA.push(p) })
  const rogueA = /** @type {any} */ (window).rogue
  const nodeB = await createRogueNode({ element: elB, replicaId: 2 })
  const rogueB = /** @type {any} */ (window).rogue
  return {
    elA, elB, nodeA, nodeB, rogueA, rogueB,
    /** Deliver everything A has committed so far to B. */
    deliver() {
      for (const p of pendingA) nodeB.mergeOp(p)
      pendingA.length = 0
    },
  }
}

describe('small change, wide structural effect (remote render stays consistent)', () => {
  it('split a <p> into two', async () => {
    const p = await setupPair()
    await type(p.elA, '<p>abcd</p>')
    p.deliver() // B bootstraps to the same doc
    await type(p.elA, '<p>ab</p><p>cd</p>') // local split → structural op
    p.deliver() // B renders the split remotely

    expect(p.elB.innerHTML).toBe('<p>ab</p><p>cd</p>')
    assertConsistent('split p (remote)', p.elB, p.rogueB)
  })

  it('merge two <p> into one', async () => {
    const p = await setupPair()
    await type(p.elA, '<p>ab</p><p>cd</p>')
    p.deliver()
    await type(p.elA, '<p>abcd</p>') // local merge → structural op
    p.deliver()

    expect(p.elB.innerHTML).toBe('<p>abcd</p>')
    assertConsistent('merge p (remote)', p.elB, p.rogueB)
  })

  it('wrap a range across a block boundary in <div>', async () => {
    const p = await setupPair()
    await type(p.elA, '<p>ab</p><p>cd</p>')
    p.deliver()
    await type(p.elA, '<div><p>ab</p><p>cd</p></div>') // wrap across blocks
    p.deliver()

    expect(p.elB.innerHTML).toBe('<div><p>ab</p><p>cd</p></div>')
    assertConsistent('wrap across boundary (remote)', p.elB, p.rogueB)
  })

  it('split inside a table cell re-renders just the cell subtree', async () => {
    const p = await setupPair()
    await type(p.elA, '<table><tbody><tr><td>ab</td><td>cd</td></tr></tbody></table>')
    p.deliver()
    await type(p.elA, '<table><tbody><tr><td>a</td><td>bcd</td></tr></tbody></table>')
    p.deliver()

    expect(p.elB.innerHTML).toBe('<table><tbody><tr><td>a</td><td>bcd</td></tr></tbody></table>')
    assertConsistent('table cell split (remote)', p.elB, p.rogueB)
  })
})
