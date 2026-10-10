// @ts-check
//
// Order-independence probe for the out-of-order convergence bug the fuzzer found
// (N=3, plain ASCII, two fully-drained replicas ended up different). A char CRDT
// must converge no matter the delivery order. Here we author a mix of inserts AND
// deletes on one node, capture every emitted op, then replay that exact set to
// fresh nodes in different orders and require identical results. Reversed order
// forces every dependency to arrive late (parked then unparked), and — the prime
// suspect — a delete to arrive before the insert of the character it targets.

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

describe('op reordering converges (parking + order-independence)', () => {
  it('the same ops in original vs reversed order produce identical docs', async () => {
    // 1. Author a sequence of edits, capturing every emitted op in order.
    const elS = editor()
    /** @type {Uint8Array[]} */ const ops = []
    const S = await createRogueNode({ element: elS, onCommit: (p) => ops.push(p) })
    const rogueS = /** @type {any} */ (window).rogue

    /** @param {string} text set the paragraph's text and let it sync */
    async function setText(text) {
      const p = /** @type {Element} */ (elS.querySelector('p'))
      const t = firstText(p)
      if (t) t.data = text
      else elS.innerHTML = `<p>${text}</p>`
      await flush()
    }

    elS.innerHTML = '<p>hello world</p>'; await flush()
    await setText('hello brave world')       // insert
    await setText('hello brave new world')   // insert
    await setText('hello new world')         // delete "brave "
    await setText('hello new bright world')  // insert
    await setText('ello new bright world')   // delete leading "h"
    await setText('ello new bright orld')    // delete "w"

    const target = rogueS.render()

    // 2. Replay the captured ops to a fresh node in a given order, draining fully.
    /** @param {number[]} order */
    async function replay(order) {
      const el = editor()
      const node = await createRogueNode({ element: el })
      const rogue = /** @type {any} */ (window).rogue
      for (const i of order) node.mergeOp(ops[i])
      return { el, node, rogue }
    }

    const inOrder = ops.map((_, i) => i)
    const reversed = [...inOrder].reverse()

    const X = await replay(inOrder)
    const Y = await replay(reversed)

    expect(X.rogue.render(), 'in-order replay ≠ source').toBe(target)
    expect(Y.rogue.render(), 'reversed replay ≠ in-order (order-dependent!)').toBe(X.rogue.render())
    expect(Y.el.innerHTML, 'reversed replay DOM diverged').toBe(X.el.innerHTML)

    S.destroy(); X.node.destroy(); Y.node.destroy()
    elS.remove(); X.el.remove(); Y.el.remove()
  })

  it('a delivery that lands out-of-(seq,replica)-order (the fold) drops nothing', async () => {
    // Author a known edit history, then deliver the highest-gid op FIRST and the
    // rest in order. The second delivery is out of order, so opSync takes the
    // destructive fold path (rogue_reset + re-merge in (seq,replica) order). The
    // fold must re-merge every group — a missing dependency would otherwise be
    // silently dropped (merge's return was ignored).
    const elS = editor()
    /** @type {Uint8Array[]} */ const ops = []
    const S = await createRogueNode({ element: elS, onCommit: (p) => ops.push(p) })
    const rogueS = /** @type {any} */ (window).rogue

    /** @param {string} text */
    async function setText(text) {
      const p = /** @type {Element} */ (elS.querySelector('p'))
      const t = firstText(p)
      if (t) t.data = text
      else elS.innerHTML = `<p>${text}</p>`
      await flush()
    }

    elS.innerHTML = '<p>hello world</p>'; await flush()
    await setText('hello brave world')       // op 0
    await setText('hello brave new world')   // op 1
    await setText('hello new world')         // op 2 (delete "brave ")
    await setText('hello new bright world')  // op 3
    const target = rogueS.render()

    const el = editor()
    const node = await createRogueNode({ element: el })
    const rogue = /** @type {any} */ (window).rogue
    // Highest gid first (at-head), then the rest — the following deliveries arrive
    // out of order and take the fold path.
    const order = [ops.length - 1, ...Array.from({ length: ops.length - 1 }, (_, i) => i)]
    for (const i of order) node.mergeOp(ops[i])

    expect(rogue.render(), 'fold dropped content').toBe(target)
    expect(el.innerHTML, 'fold left DOM diverged').toBe(target)

    S.destroy(); node.destroy(); elS.remove(); el.remove()
  })
})
