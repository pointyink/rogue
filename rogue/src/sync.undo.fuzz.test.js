// @ts-check
//
// Single-node undo fuzz: generate a rich structural doc, then undo it all the way
// back to empty, running the consistency oracle at every step.
//
// Undo in rogue is just another op: each undo emits an inverse op (fresh ids) that's
// appended to the oplog, and the internal cursor — a content address — marches back
// one op at a time. Consecutive undos therefore walk the history back to empty. This
// is a feature, not a limitation: undos are convergent, durable edits, and the
// content-address cursor is the primitive underneath per-author undo and time travel.
// (Interleaving an *edit* between undos resets the cursor to head — "undo is forward
// progress" — which is correct and is a separate contract; a clean-LIFO / per-author
// undo UX layers on top via the external-cursor hook `rogue_undo(cursor)`.)

import { describe, it, expect } from 'vitest'
import { createRogueNode } from './sync.js'
import { mulberry32, flush, applyEdit, normalize, assertConsistent } from './fuzz-helpers.js'

// Full edit generator (structural: split/merge/wrap/nest/blocks/tables).
const FULL_EDIT_KINDS = 12

const STEPS = 300
const SEEDS = [1, 2, 7, 42, 86, 1337]

/** @param {number} seed */
async function runUndoFuzz(seed) {
  const rng = mulberry32(seed)
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  document.body.appendChild(el)

  const node = await createRogueNode({ element: el, replicaId: 1, onCommit() {} })
  const rogue = /** @type {any} */ (window).rogue // the node's debug API

  try {
    // Build up a rich doc.
    for (let step = 0; step < STEPS; step++) {
      applyEdit(rng, el, FULL_EDIT_KINDS)
      normalize(el)
      await flush()
      assertConsistent(`seed=${seed} edit step=${step}`, el, rogue)
    }

    // Undo all the way back to empty.
    let undos = 0
    while (el.innerHTML !== '') {
      if (++undos > STEPS * 4) throw new Error(`seed=${seed}: undo did not reach empty`)
      node.undo()
      await flush()
      assertConsistent(`seed=${seed} undo #${undos}`, el, rogue)
    }
    expect(el.innerHTML, `seed=${seed} — should end empty`).toBe('')
  } finally {
    node.destroy()
    el.remove()
  }
}

describe('sync undo fuzz: drains a rich doc back to empty', () => {
  for (const seed of SEEDS) {
    it(`undoes ${STEPS} rich edits to empty (seed ${seed})`, async () => {
      await runUndoFuzz(seed)
    })
  }
})
