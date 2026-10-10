// @ts-check
//
// DOM-drain race: a remote op that arrives while a user edit is still sitting in
// the MutationObserver queue (unflushed) must not drop that edit. The engine's
// `selfMutate` drains *all* pending observer records via takeRecords() — including
// the user's — and then re-renders from a CRDT state that never saw the edit, so
// the character is silently lost.

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

/** @param {Node} n @returns {Text | null} */
function firstText(n) {
  for (const c of n.childNodes) {
    if (c.nodeType === 3) return /** @type {Text} */ (c)
    if (c.nodeType === 1) { const r = firstText(c); if (r) return r }
  }
  return null
}

describe('DOM-drain: remote op vs in-flight local edit', () => {
  it('a remote op arriving mid-input does not drop the in-flight char', async () => {
    // Force the full-doc render path so a remote op deterministically re-renders
    // the whole editor (the partial path shares the same takeRecords drain).
    /** @type {any} */ (globalThis).__rogueForceFullSync = true
    try {
      const elA = editor()
      const elB = editor()
      /** @type {Uint8Array[]} */ const opsA = []
      /** @type {Uint8Array[]} */ const opsB = []
      const A = await createRogueNode({ element: elA, replicaId: 1, onCommit: (p) => opsA.push(p) })
      const rogueA = /** @type {any} */ (window).rogue // capture A's debug API before B overwrites it
      const B = await createRogueNode({ element: elB, replicaId: 2, onCommit: (p) => opsB.push(p) })

      // A authors "hello" and B syncs it, so both share the same base chars.
      elA.innerHTML = '<p>hello</p>'
      await flush()
      for (const op of opsA) B.mergeOp(op)
      opsA.length = 0

      // B types " world" → emits one op (parent = A's 'o', present on both).
      const tB = /** @type {Text} */ (firstText(/** @type {Element} */ (elB.querySelector('p'))))
      tB.data = 'hello world'
      await flush()
      expect(opsB.length).toBeGreaterThan(0)

      // A: user types "X" at the end, but do NOT flush — the observer hasn't run.
      const tA = /** @type {Text} */ (firstText(/** @type {Element} */ (elA.querySelector('p'))))
      tA.data = 'helloX'

      // A: the remote op from B arrives synchronously, before A's observer fires.
      A.mergeOp(opsB[opsB.length - 1])
      await flush()

      expect(rogueA.render(), 'in-flight char was dropped').toBe('<p>hello worldX</p>')
    } finally {
      /** @type {any} */ (globalThis).__rogueForceFullSync = false
    }
  })
})
