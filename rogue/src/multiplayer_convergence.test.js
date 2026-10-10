// @ts-check
//
// Layer 1: multi-replica convergence through the JS wrapper (sync.js).
//
// The Zig side already has `convergence: N replicas random ops` covering the
// CRDT math at scale (rogue/crdt/rogue.zig). This file exercises the *JS*
// layer — DMP diff, mergeOp, partial rerender, cursor restore — by driving
// real DOM events (`type`, `keydown`) into N `createRogueNode` instances,
// gossiping ops between them in a randomized in-memory network, and
// asserting that every editor's innerHTML matches at the end.
//
// vitest is configured for `jsdom` (see rogue/vitest.config.js) so document /
// HTMLElement / events all work the same way they do in sync.test.js. No
// extra setup needed.
//
// If these pass while users still see corruption: the bug is in the wire
// or server layer (Layer 2 — server hub fan-out, sync race, etc).

import { describe, test, expect } from 'vitest'
import { createRogueNode } from './sync.js'

// ---- DOM helpers (same pattern as sync.test.js) ---------------------------

/** @returns {HTMLElement} */
function makeEditor() {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  document.body.appendChild(el)
  return el
}

/** Let the engine's MutationObserver deliver + process pending mutations. */
const flush = () => new Promise((r) => setTimeout(r, 0))

/** Set innerHTML, then let the observer sync — same path a user keystroke takes. */
async function type(/** @type {HTMLElement} */ el, /** @type {string} */ html) {
  el.innerHTML = html
  await flush()
}

/** Fire a Cmd+Z keydown (triggers the sync.js undo path). */
function undoKey(/** @type {HTMLElement} */ el) {
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }),
  )
}

// ---- seeded PRNG ----------------------------------------------------------

/** @param {number} seed */
function mulberry32(seed) {
  let s = seed | 0
  return function () {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rint = (/** @type {() => number} */ rng, /** @type {number} */ n) => Math.floor(rng() * n)

// ---- N-replica setup with per-(target, source) gossip queues --------------
//
// `inboxes[target][source]` is the FIFO queue of payloads emitted by `source`
// destined for `target`. Per-source ordering at each target is preserved
// (causal), but the choice of *which* source to drain from at each step is
// random — so two targets can see ops from different sources interleaved
// differently. Mirrors the Zig N-replica convergence test.

/** @param {number} n */
async function setupReplicas(n) {
  const editors = /** @type {HTMLElement[]} */ ([])
  const nodes = /** @type {any[]} */ ([])
  const inboxes = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => /** @type {Uint8Array[]} */ ([])),
  )

  for (let i = 0; i < n; i++) {
    const el = makeEditor()
    editors.push(el)
    const node = await createRogueNode({
      element: el,
      onCommit: (payload) => {
        for (let tgt = 0; tgt < n; tgt++) {
          if (tgt !== i) inboxes[tgt][i].push(payload)
        }
      },
    })
    nodes.push(node)
  }

  /** Total pending count across all (target, source) queues. */
  function pending() {
    let total = 0
    for (let t = 0; t < n; t++) for (let s = 0; s < n; s++) total += inboxes[t][s].length
    return total
  }

  return {
    editors,
    nodes,
    inboxes,
    pending,

    /**
     * Deliver one op: pick a random target with anything pending, then pick
     * a random source within that target that has at least one pending op,
     * then shift that source's queue and apply. Returns true if work
     * happened, false if everything is drained.
     * @param {() => number} rng
     */
    step(rng) {
      const targets = /** @type {number[]} */ ([])
      for (let t = 0; t < n; t++) {
        for (let s = 0; s < n; s++) {
          if (inboxes[t][s].length > 0) {
            targets.push(t)
            break
          }
        }
      }
      if (targets.length === 0) return false
      const target = targets[rint(rng, targets.length)]

      const sources = /** @type {number[]} */ ([])
      for (let s = 0; s < n; s++) {
        if (inboxes[target][s].length > 0) sources.push(s)
      }
      const source = sources[rint(rng, sources.length)]

      const payload = /** @type {Uint8Array} */ (inboxes[target][source].shift())
      nodes[target].mergeOp(payload)
      return true
    },

    /**
     * Deliver everything, randomly interleaving sources at each target.
     * Different targets end up seeing ops in different orders, which is the
     * point of this test.
     * @param {() => number} rng
     */
    drain(rng) {
      const MAX_STEPS = 100_000
      let steps = 0
      while (this.step(rng)) {
        if (++steps > MAX_STEPS) {
          throw new Error(`drain: exceeded ${MAX_STEPS} steps (apply loop emitting new ops?)`)
        }
      }
    },

    destroy() {
      nodes.forEach((n) => n.destroy())
      editors.forEach((e) => e.remove())
    },
  }
}

/** @param {HTMLElement[]} editors */
function assertConverged(editors) {
  for (let i = 1; i < editors.length; i++) {
    expect(
      editors[i].innerHTML,
      `editor[${i}] diverged from editor[0]:\n  [0]: ${editors[0].innerHTML}\n  [${i}]: ${editors[i].innerHTML}`,
    ).toBe(editors[0].innerHTML)
  }
}

// ---- tests ----------------------------------------------------------------

describe('layer 1: multi-replica convergence via sync.js', () => {
  test('sanity: two replicas, one types, gossip converges', async () => {
    const rng = mulberry32(1)
    const net = await setupReplicas(2)
    await type(net.editors[0], 'hello world')
    net.drain(rng)
    assertConverged(net.editors)
    expect(net.editors[1].innerHTML).toContain('hello')
    net.destroy()
  })

  test('concurrent undo storm: both replicas author, both hammer undo', async () => {
    // Bug repro: two users both held Cmd+Z and the doc landed in a state
    // neither had authored. If this test passes, the storm bug is above
    // sync.js (server-side hub fan-out, ack/sync race, etc).
    const rng = mulberry32(2)
    const net = await setupReplicas(2)

    await type(net.editors[0], 'hello')
    net.drain(rng)
    await type(net.editors[1], 'hello world')
    net.drain(rng)
    assertConverged(net.editors)

    // Both hammer undo concurrently. Each undoKey emits one inverse op
    // (via onCommit) which goes into the other replica's inbox.
    for (let i = 0; i < 10; i++) {
      undoKey(net.editors[0])
      undoKey(net.editors[1])
    }
    net.drain(rng)
    assertConverged(net.editors)

    // After the storm: a fresh single-author edit should still land cleanly
    // on both replicas — the "single-player edits stopped saving after the
    // storm" symptom would surface here.
    await type(net.editors[0], net.editors[0].innerHTML + 'X')
    net.drain(rng)
    assertConverged(net.editors)
    expect(net.editors[1].innerHTML).toContain('X')

    net.destroy()
  })

  test('N=3 replicas, random type/undo with interleaved gossip', async () => {
    const N = 3
    const STEPS = 300
    const rng = mulberry32(0xc0ffee)
    const net = await setupReplicas(N)

    for (let step = 0; step < STEPS; step++) {
      const idx = rint(rng, N)
      const el = net.editors[idx]
      const action = rint(rng, 10)

      if (action < 5) {
        // Type one random ASCII char somewhere in the current innerHTML.
        const cur = el.innerHTML
        const pos = rint(rng, cur.length + 1)
        const ch = String.fromCharCode(97 + rint(rng, 26))
        await type(el, cur.slice(0, pos) + ch + cur.slice(pos))
      } else if (action < 7) {
        undoKey(el)
      } else {
        // Deliver one queued op somewhere (random target + random source).
        net.step(rng)
      }
    }

    net.drain(rng)
    assertConverged(net.editors)
    net.destroy()
  })

  // Same shape as the previous test but without undo — narrows divergence
  // to the type+gossip interaction independent of the undo path. Kept as a
  // permanent regression guard alongside the undo variant.
  test('N=3 replicas, random type-only with interleaved gossip (no undo)', async () => {
    const N = 3
    const STEPS = 300
    const rng = mulberry32(0xc0ffee)
    const net = await setupReplicas(N)

    for (let step = 0; step < STEPS; step++) {
      const idx = rint(rng, N)
      const el = net.editors[idx]
      const action = rint(rng, 10)

      if (action < 7) {
        const cur = el.innerHTML
        const pos = rint(rng, cur.length + 1)
        const ch = String.fromCharCode(97 + rint(rng, 26))
        await type(el, cur.slice(0, pos) + ch + cur.slice(pos))
      } else {
        net.step(rng)
      }
    }

    net.drain(rng)
    assertConverged(net.editors)
    net.destroy()
  })
})
