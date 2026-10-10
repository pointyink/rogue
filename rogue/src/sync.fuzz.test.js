// @ts-check
//
// Sync-layer fuzz harness: N replicas, rich structural edits, chaotic gossip.
//
// Builds on the network model in multiplayer_convergence.test.js (per-(target,
// source) inbox queues, randomized interleaved delivery). The rich edit generator
// and the per-agent consistency oracle now live in fuzz-helpers.js (shared with the
// single-node undo fuzz).
//
// On failure it throws with seed + step + the per-agent edit log, so any
// divergence is a one-line reproduction. Bump N / STEPS / SEEDS to hunt harder.

import { describe, it, expect } from 'vitest'
import { createRogueNode } from './sync.js'
import { mulberry32, rint, pick, flush, applyEdit, normalize, assertConsistent } from './fuzz-helpers.js'

// ---- N-replica network ----------------------------------------------------

/** @param {number} n @param {number[]} replicaIds */
async function setupReplicas(n, replicaIds) {
  const editors = /** @type {HTMLElement[]} */ ([])
  const nodes = /** @type {any[]} */ ([])
  const rogues = /** @type {any[]} */ ([]) // per-node debug API (render / rope)
  const inboxes = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => /** @type {Uint8Array[]} */ ([])),
  )

  for (let i = 0; i < n; i++) {
    const el = document.createElement('div')
    el.setAttribute('contenteditable', 'true')
    document.body.appendChild(el)
    editors.push(el)
    const node = await createRogueNode({
      element: el,
      replicaId: replicaIds[i],
      onCommit: (payload) => {
        for (let tgt = 0; tgt < n; tgt++) if (tgt !== i) inboxes[tgt][i].push(payload)
      },
    })
    nodes.push(node)
    rogues.push(/** @type {any} */ (window).rogue) // set to the just-created node
  }

  const pending = () => {
    let total = 0
    for (let t = 0; t < n; t++) for (let s = 0; s < n; s++) total += inboxes[t][s].length
    return total
  }

  /** Deliver one op to a random target/source. Returns the target index, or -1 if drained.
   * @param {() => number} rng */
  function deliverOne(rng) {
    const targets = /** @type {number[]} */ ([])
    for (let t = 0; t < n; t++) {
      for (let s = 0; s < n; s++) if (inboxes[t][s].length > 0) { targets.push(t); break }
    }
    if (targets.length === 0) return -1
    const target = pick(rng, targets)
    const sources = /** @type {number[]} */ ([])
    for (let s = 0; s < n; s++) if (inboxes[target][s].length > 0) sources.push(s)
    const source = pick(rng, sources)
    nodes[target].mergeOp(/** @type {Uint8Array} */ (inboxes[target][source].shift()))
    return target
  }

  return {
    editors, nodes, rogues, pending, deliverOne,
    destroy() { nodes.forEach((x) => x.destroy()); editors.forEach((e) => e.remove()) },
  }
}

// ---- the fuzz test --------------------------------------------------------

/**
 * Run the N-replica fuzz for one seed + replica-id assignment. Shared by the main
 * regression suite and the id-assignment sweep below.
 * @param {number} seed
 * @param {number[]} replicaIds
 * @param {number} N
 * @param {number} STEPS
 * @param {number} [undoBias] Probability (0..1) that a step is an undo on a random
 *   replica instead of an edit/delivery. Undo emits an inverse op that is gossiped
 *   like any other edit, so it exercises "undo is a convergent op".
 */
async function runFuzz(seed, replicaIds, N, STEPS, undoBias = 0) {
  /** @type {any} */ (globalThis).__rogueForceFullSync = false

  const rng = mulberry32(seed)
  const net = await setupReplicas(N, replicaIds)
  /** @type {string[][]} per-agent edit log */
  const log = Array.from({ length: N }, () => /** @type {string[]} */ ([]))

  const DRAIN_CAP = 100_000
  /** Deliver every pending op, oracle each recipient, then assert convergence.
   * @param {string} ctx */
  function quiesce(ctx) {
    let steps = 0
    for (let tgt = net.deliverOne(rng); tgt !== -1; tgt = net.deliverOne(rng)) {
      if (++steps > DRAIN_CAP) throw new Error(`${ctx}: drain exceeded ${DRAIN_CAP}`)
    }
    for (let i = 0; i < N; i++) net.nodes[i].drainParked()
    for (let i = 0; i < N; i++) {
      assertConsistent(`${ctx} :: agent ${i}`, net.editors[i], net.rogues[i])
    }
    for (let i = 1; i < N; i++) {
      expect(
        net.editors[i].innerHTML,
        `${ctx} — agent ${i} diverged from agent 0\n  [0]: ${net.editors[0].innerHTML}\n  [${i}]: ${net.editors[i].innerHTML}`,
      ).toBe(net.editors[0].innerHTML)
    }
  }

  try {
    for (let step = 0; step < STEPS; step++) {
      const roll = rng()
      if (undoBias > 0 && roll < undoBias) {
        // Undo on a random replica: emits an inverse op (gossiped via onCommit) and
        // applies it locally. Convergence afterward is the claim under test.
        const i = rint(rng, N)
        net.nodes[i].undo()
        log[i].push('undo')
        await flush()
        assertConsistent(`seed=${seed} step=${step} undo→agent${i} ${log[i].join(',')}`,
          net.editors[i], net.rogues[i])
      } else if (net.pending() === 0 || roll < 0.55 + undoBias) {
        // Bias toward edits, but drain often enough that inboxes don't explode.
        const i = rint(rng, N)
        const label = applyEdit(rng, net.editors[i])
        normalize(net.editors[i])
        log[i].push(label)
        await flush()
        assertConsistent(`seed=${seed} step=${step} agent=${i} [${label}] ${log[i].join(',')}`,
          net.editors[i], net.rogues[i])
      } else {
        const tgt = net.deliverOne(rng)
        if (tgt !== -1) {
          // Oracle every recipient, not just at quiesce: a non-atomic merge
          // (a multi-op group that partially applies before parking) corrupts on
          // a single delivery, and only the recipient catches it.
          assertConsistent(`seed=${seed} step=${step} delivered→agent${tgt}`, net.editors[tgt], net.rogues[tgt])
        }
      }
    }

    // Final: drain everything, oracle each recipient, assert full convergence.
    quiesce(`seed=${seed} final`)
    for (let i = 0; i < N; i++) {
      assertConsistent(`seed=${seed} final agent ${i}`, net.editors[i], net.rogues[i])
    }
  } finally {
    /** @type {any} */ (globalThis).__rogueForceFullSync = false
    try { net.destroy() } catch { /* don't mask the real failure */ }
  }
}

describe('sync fuzz: N replicas, rich edits, chaotic gossip', () => {
  const N = 3
  const STEPS = 200
  const SEEDS = [1, 2, 7, 42, 86, 1337]
  const IDS = [1, 2, 3]

  for (const seed of SEEDS) {
    it(`stays internally consistent + converges (N=${N}, seed ${seed})`, async () => {
      await runFuzz(seed, IDS, N, STEPS)
    })
  }
})

// The off-by-one bug was replica-id-dependent (surfaced only for certain
// assignments). Sweep several id assignments so we exercise the interleaving the
// merge tie-break depends on, and prove the fix isn't id-specific.
describe('sync fuzz: replica-id assignment sweep', () => {
  const N = 3
  const STEPS = 200
  const SEEDS = [1, 42, 86, 1337]
  const ASSIGNMENTS = [[1, 2, 3], [3, 2, 1], [2, 1, 3], [100, 200, 300]]

  for (const ids of ASSIGNMENTS) {
    for (const seed of SEEDS) {
      it(`converges (ids [${ids.join(',')}], seed ${seed})`, async () => {
        await runFuzz(seed, ids, N, STEPS)
      })
    }
  }
})

// Undo is just another op: each undo emits an inverse op that's gossiped like any
// edit, so every replica must converge on the undone state. Exercises the
// "undos are edits progressing the doc forward" property directly.
describe('sync fuzz: undo converges across replicas', () => {
  const N = 3
  const STEPS = 200
  const UNDO_BIAS = 0.15
  const SEEDS = [1, 2, 7, 42, 86, 1337]
  const IDS = [1, 2, 3]

  for (const seed of SEEDS) {
    it(`stays consistent + converges with undo (N=${N}, seed ${seed})`, async () => {
      await runFuzz(seed, IDS, N, STEPS, UNDO_BIAS)
    })
  }
})
