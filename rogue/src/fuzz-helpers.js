// @ts-check
//
// Shared fuzz harness pieces: seeded PRNG, a rich structural edit generator, and
// the per-agent consistency oracle. Used by both the multi-replica convergence
// fuzz (sync.fuzz.test.js) and the single-node undo fuzz (sync.undo.fuzz.test.js).
//
// The edit generator mutates a contenteditable the way a user would — via DOM
// APIs (textContent / element nodes / splitText), never innerHTML string building,
// so raw & < > can't accidentally become markup.

import { expect } from 'vitest'
import { buildRope } from './dom_rope.js'

// ---- seeded PRNG ----------------------------------------------------------

/** @param {number} seed */
export function mulberry32(seed) {
  let s = seed | 0
  return function () {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export const rint = (/** @type {() => number} */ rng, /** @type {number} */ n) => Math.floor(rng() * n)
export const rrange = (/** @type {() => number} */ rng, /** @type {number} */ lo, /** @type {number} */ hi) =>
  lo + Math.floor(rng() * (hi - lo + 1)) // inclusive
export const pick = (/** @type {() => number} */ rng, /** @type {any[]} */ arr) => arr[rint(rng, arr.length)]

export const flush = () => new Promise((r) => setTimeout(r, 0))

// ---- content generators ---------------------------------------------------

export const WORDS = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'quis', 'enim', 'ad', 'veniam', 'x', 'yo']
export const BLOCK_TAGS = ['p', 'div', 'h2', 'blockquote']
export const INLINE_TAGS = ['b', 'u', 'i', 'em', 'strong', 'code']
// Fragments that force HTML-escaping on the scoped diff — the class of bug that
// motivated this harness (trailing space → &nbsp;, and & < >).
export const ENTITY_BITS = [' & ', ' < ', ' > ', ' a & b ', '<x>', ' ']
// Isolation knob: inject HTML-special chars into generated text. Off → pure ASCII.
export const USE_ENTITIES = false
// Isolation knob: how many of applyEdit's cases are reachable. 0–2 are pure text;
// 3+ add structural edits (split, merge, wrap, nest, blocks, tables). Full = 12.
export const EDIT_KINDS = 3

/** @param {() => number} rng @param {boolean} [entities] */
export function words(rng, entities = false) {
  let t = Array.from({ length: rrange(rng, 1, 4) }, () => pick(rng, WORDS)).join(' ')
  if (USE_ENTITIES && entities && rng() < 0.8) {
    const bit = pick(rng, ENTITY_BITS)
    t = rng() < 0.5 ? t + bit : bit + t
  }
  return t
}

/** @param {() => number} rng @param {string} [tag] */
export function makeBlock(rng, tag = pick(rng, BLOCK_TAGS)) {
  const b = document.createElement(tag)
  b.textContent = words(rng, rng() < 0.4)
  return b
}

/** First text node under a subtree (depth-first). @param {Node} n @returns {Text | null} */
export function firstText(n) {
  for (const c of n.childNodes) {
    if (c.nodeType === 3) return /** @type {Text} */ (c)
    if (c.nodeType === 1) { const r = firstText(c); if (r) return r }
  }
  return null
}

// ---- edit generator -------------------------------------------------------
//
// Mutates a contenteditable `el` (block children) the way a user would. Returns a
// short label; labels containing "skip" mean the case was a no-op (no DOM change).

/** @param {() => number} rng @param {HTMLElement} el @param {number} [editKinds] */
export function applyEdit(rng, el, editKinds = EDIT_KINDS) {
  const blocks = /** @type {HTMLElement[]} */ ([...el.children])
  if (blocks.length === 0) { el.appendChild(makeBlock(rng)); return 'seed' }
  const block = pick(rng, blocks)

  switch (rint(rng, editKinds)) {
    case 0: { // type into a text node (maybe entity chars)
      const t = firstText(block)
      const ins = words(rng, rng() < 0.5)
      if (!t) { block.textContent = ins; return 'settext' }
      const at = rrange(rng, 0, t.data.length)
      t.data = t.data.slice(0, at) + ins + t.data.slice(at)
      return `type@${at}`
    }
    case 1: { // select + type: replace a range of a text node
      const t = firstText(block)
      if (!t || t.data.length < 2) return 'seltype:skip'
      const a = rrange(rng, 0, t.data.length - 1)
      const b = rrange(rng, a + 1, t.data.length)
      t.data = t.data.slice(0, a) + words(rng, rng() < 0.4) + t.data.slice(b)
      return `seltype[${a},${b}]`
    }
    case 2: { // delete a substring
      const t = firstText(block)
      if (!t || t.data.length < 2) return 'del:skip'
      const a = rrange(rng, 0, t.data.length - 1)
      const b = rrange(rng, a + 1, t.data.length)
      t.data = t.data.slice(0, a) + t.data.slice(b)
      return `del[${a},${b}]`
    }
    case 3: { // Enter: split a block into two
      const t = firstText(block)
      if (!t || t.data.length < 2) return 'split:skip'
      const at = rrange(rng, 1, t.data.length - 1)
      const right = document.createElement(block.tagName.toLowerCase())
      right.textContent = t.data.slice(at)
      t.data = t.data.slice(0, at)
      block.after(right)
      return `split@${at}`
    }
    case 4: { // Backspace-at-start: merge two adjacent blocks
      if (blocks.length < 2) return 'merge:skip'
      const i = rrange(rng, 0, blocks.length - 2)
      blocks[i].append(...blocks[i + 1].childNodes)
      blocks[i + 1].remove()
      return `merge@${i}`
    }
    case 5: { // bold/underline a sub-range (partial-range inline wrap)
      const t = firstText(block)
      if (!t || t.data.length < 2) return 'wrap:skip'
      const a = rrange(rng, 0, t.data.length - 1)
      const b = rrange(rng, a + 1, t.data.length)
      const mid = t.splitText(a)
      mid.splitText(b - a)
      const tag = pick(rng, INLINE_TAGS)
      const span = document.createElement(tag)
      span.textContent = mid.data
      mid.replaceWith(span)
      return `wrap<${tag}>[${a},${b}]`
    }
    case 6: { // append a nested inline
      const span = document.createElement(pick(rng, INLINE_TAGS))
      span.textContent = words(rng, rng() < 0.4)
      block.appendChild(span)
      return 'nest'
    }
    case 7: // insert a new block
      el.insertBefore(makeBlock(rng), rng() < 0.5 ? block : block.nextSibling)
      return 'newblock'
    case 8: // remove a block (keep ≥1)
      if (blocks.length > 1) { block.remove(); return 'rmblock' }
      return 'rmblock:skip'
    case 9: { // insert a small table (bounded count)
      if (el.querySelectorAll('table').length >= 2) return 'table:skip'
      const rows = rrange(rng, 1, 2), cols = rrange(rng, 1, 2)
      const table = document.createElement('table')
      const tbody = document.createElement('tbody')
      for (let r = 0; r < rows; r++) {
        const tr = document.createElement('tr')
        for (let c = 0; c < cols; c++) {
          const td = document.createElement('td')
          td.textContent = words(rng, rng() < 0.3)
          tr.appendChild(td)
        }
        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
      el.insertBefore(table, rng() < 0.5 ? block : block.nextSibling)
      return `table${rows}x${cols}`
    }
    case 10: { // edit a table cell
      const cells = el.querySelectorAll('td')
      if (cells.length === 0) return 'cell:skip'
      const td = /** @type {HTMLElement} */ (cells[rint(rng, cells.length)])
      td.textContent = words(rng, rng() < 0.3)
      return 'celledit'
    }
    default: // replace a block's text entirely (entity chars likely)
      block.textContent = words(rng, true)
      return 'retext'
  }
}

/**
 * Foster-parent invalid nesting the way the HTML *parser* would, so the CRDT only
 * ever ingests round-trippable HTML. DOM mutations build the tree directly and DON'T
 * foster-parent (only parsing does), so we trigger one reparse here. No-op when the
 * content is already canonical, which keeps valid edits on the scoped-diff path.
 * @param {HTMLElement} el
 */
export function normalize(el) {
  const tmp = document.createElement('div')
  tmp.innerHTML = el.innerHTML // parse: relocates misplaced table content, etc.
  if (tmp.innerHTML !== el.innerHTML) el.innerHTML = tmp.innerHTML
}

// ---- oracle ---------------------------------------------------------------

/** Every tracked descendant (elements + text). @param {Element} el @returns {Node[]} */
export function descendants(el) {
  /** @type {Node[]} */
  const out = []
  const walk = (/** @type {Node} */ n) => {
    for (const c of n.childNodes) { out.push(c); if (c.nodeType === 1) walk(c) }
  }
  walk(el)
  return out
}

/** @param {any} rope @param {string} html @returns {number} index→char mismatches */
export function indexMismatches(rope, html) {
  let bad = 0
  for (let i = 0; i < html.length; i++) {
    const r = rope.getAtVisIx(i)
    if (!r || r.node.text[r.offset] !== html[i]) bad++
  }
  return bad
}

/** Treap invariants: heap / subtree weight / parent pointers. @param {any} node */
export function treeViolations(node) {
  let heap = 0, weight = 0, parent = 0
  const walk = (/** @type {any} */ n) => {
    if (!n) return
    if (n.left && n.priority < n.left.priority) heap++
    if (n.right && n.priority < n.right.priority) heap++
    if (n.weight !== (n.left?.weight ?? 0) + n.text.length + (n.right?.weight ?? 0)) weight++
    if (n.left && n.left.parent !== n) parent++
    if (n.right && n.right.parent !== n) parent++
    walk(n.left); walk(n.right)
  }
  walk(node)
  return { heap, weight, parent }
}

/** @param {Node} n */
export function describeNode(n) {
  if (n.nodeType === 3) return `#text${JSON.stringify((/** @type {Text} */ (n).data).slice(0, 16))}`
  return `<${(/** @type {Element} */ (n)).tagName.toLowerCase()}>`
}

/**
 * Per-agent internal consistency: CRDT ≡ DOM ≡ rope, plus index walk, treap
 * integrity, and per-node position parity with a fresh rope over the same DOM.
 * @param {string} ctx @param {HTMLElement} el @param {any} rogue
 */
export function assertConsistent(ctx, el, rogue) {
  const html = el.innerHTML
  const rope = rogue.rope()

  expect(rogue.render(), `${ctx} — CRDT render ≠ DOM\n  crdt: ${rogue.render()}\n  dom : ${html}`).toBe(html)
  expect(rope.serialize(), `${ctx} — rope serialize ≠ DOM`).toBe(html)
  expect(indexMismatches(rope, html), `${ctx} — index walk mismatches`).toBe(0)
  expect(treeViolations(rope.root), `${ctx} — treap invariants`).toEqual({ heap: 0, weight: 0, parent: 0 })

  const fresh = buildRope(el)
  for (const node of descendants(el)) {
    const live = JSON.stringify(rope.getRange(node))
    const ref = JSON.stringify(fresh ? fresh.getRange(node) : null)
    expect(live, `${ctx} — getRange drift @ ${describeNode(node)} (live ${live} vs fresh ${ref})`).toBe(ref)
  }
}
