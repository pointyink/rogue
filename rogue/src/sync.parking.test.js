// @ts-check
//
// Minimal repro for the out-of-order (parking) divergence the fuzzer surfaced:
// an op that arrives before its dependency is parked, then applied via
// drainParked when the dependency lands. With ≥3 replicas this happens under
// normal gossip (an op from source X can depend on an op from source Y not yet
// delivered). The fuzzer showed it leaving an agent's CRDT ≠ its own DOM.

import { describe, it, expect } from 'vitest'
import { createRogueNode } from './sync.js'

const flush = () => new Promise((r) => setTimeout(r, 0))

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
    if (c.nodeType === 1) { const r = firstText(c); if (r) return r }
  }
  return null
}

describe('out-of-order op delivery (parking)', () => {
  it('a parked op, unparked by its dependency, keeps CRDT ≡ DOM and converges', async () => {
    const elA = editor(), elB = editor(), elC = editor()
    /** @type {Uint8Array[]} */ const fromA = []
    /** @type {Uint8Array[]} */ const fromB = []

    const A = await createRogueNode({ element: elA, onCommit: (p) => fromA.push(p) })
    const rogueA = /** @type {any} */ (window).rogue
    const B = await createRogueNode({ element: elB, onCommit: (p) => fromB.push(p) })
    const rogueB = /** @type {any} */ (window).rogue
    const C = await createRogueNode({ element: elC })
    const rogueC = /** @type {any} */ (window).rogue

    // A authors a paragraph. Deliver A's op to B only (not C yet).
    elA.innerHTML = '<p>hello</p>'
    await flush()
    for (const p of fromA) B.mergeOp(p)

    // B appends inside the paragraph — this op's inserts are CHILDREN of A's
    // characters, so it causally depends on A's op.
    const t = /** @type {Text} */ (firstText(/** @type {Element} */ (elB.querySelector('p'))))
    t.data = t.data + ' world'
    await flush()

    // Deliver to C OUT OF ORDER: B's dependent op first (C lacks A's chars →
    // parked), then A's op (should unpark B's op via drainParked).
    for (const p of fromB) C.mergeOp(p)   // parked
    for (const p of fromA) C.mergeOp(p)   // lands dependency → drains parked

    // C must be internally consistent and converged with B (C received B's ops).
    expect(rogueC.render(), 'C: CRDT render ≠ its own DOM').toBe(elC.innerHTML)
    expect(rogueC.rope().serialize(), 'C: rope ≠ its own DOM').toBe(elC.innerHTML)
    expect(elC.innerHTML, 'C diverged from B').toBe(elB.innerHTML)

    A.destroy(); B.destroy(); C.destroy()
    elA.remove(); elB.remove(); elC.remove()
  })
})
