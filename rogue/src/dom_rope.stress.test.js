// @ts-check
import { describe, it, expect } from 'vitest'
import { buildRope } from './index.js'
import { createRogueNode } from './sync.js'
import { mustBuildRope } from './test-helpers.js'

// ---------------------------------------------------------------------------
// Seeded RNG (xorshift32) — reproducible across runs
// ---------------------------------------------------------------------------

/** @param {number} seed @returns {() => number} uniform [0, 1) */
function makeRng(seed) {
  let s = (seed >>> 0) || 1
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return (s >>> 0) / 0x100000000
  }
}

/** @param {() => number} rng @param {any[]} arr */
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)]

/** @param {() => number} rng @param {number} lo @param {number} hi inclusive */
const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1))

// ---------------------------------------------------------------------------
// Random HTML generator
// ---------------------------------------------------------------------------

// Only tags that are valid inside any block-level container, so the browser
// won't silently restructure the DOM on parse.
const BLOCK_TAGS  = ['div', 'section', 'article', 'nav', 'aside', 'figure', 'main']
const INLINE_TAGS = ['span', 'b', 'i', 'em', 'strong', 'code', 'mark', 'abbr']
const LEAF_TAGS   = ['p', 'h2', 'h3', 'h4', 'blockquote', 'pre', 'address']
const VOID_TAGS   = ['br', 'hr']
const ATTR_NAMES  = ['class', 'id', 'data-key', 'data-val', 'title', 'lang', 'role', 'aria-label', 'tabindex']
const WORDS       = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'eiusmod', 'tempor', 'incididunt', 'labore', 'dolore', 'magna', 'aliqua',
  'enim', 'minim', 'veniam', 'quis', 'nostrud', 'exercitation', 'ullamco',
  'laboris', 'nisi', 'aliquip', 'commodo', 'consequat', 'aute', 'irure',
]

/** @param {() => number} rng */
function randomAttrValue(rng) {
  return Array.from({ length: randInt(rng, 1, 3) }, () => pick(rng, WORDS)).join('-')
}

/** @param {() => number} rng */
function randomText(rng) {
  return Array.from({ length: randInt(rng, 3, 12) }, () => pick(rng, WORDS)).join(' ')
}

/**
 * Recursively generate an HTML element string within an approximate char budget.
 * @param {() => number} rng
 * @param {number} depth
 * @param {number} budget  approximate max chars
 * @returns {string}
 */
function generateElement(rng, depth, budget) {
  const isLeaf = depth <= 0 || budget < 80
  const tag = isLeaf      ? pick(rng, LEAF_TAGS)
            : rng() < 0.4 ? pick(rng, BLOCK_TAGS)
            :                pick(rng, INLINE_TAGS)

  // 0–3 unique random attributes
  const numAttrs = randInt(rng, 0, 3)
  const usedNames = new Set()
  let attrs = ''
  for (let i = 0; i < numAttrs; i++) {
    const name = pick(rng, ATTR_NAMES)
    if (!usedNames.has(name)) {
      usedNames.add(name)
      attrs += ` ${name}="${randomAttrValue(rng)}"`
    }
  }

  const open  = `<${tag}${attrs}>`
  const close = `</${tag}>`

  if (isLeaf) {
    if (rng() < 0.05) return open + close  // occasionally empty element
    return open + randomText(rng) + close
  }

  let children = ''
  let remaining = budget - open.length - close.length
  const numChildren = randInt(rng, 2, 6)
  for (let i = 0; i < numChildren && remaining > 40; i++) {
    if (rng() < 0.06) {
      const vt = pick(rng, VOID_TAGS)
      children += `<${vt}>`
      remaining -= vt.length + 2
    } else {
      const share = Math.floor(remaining / (numChildren - i))
      const child = generateElement(rng, depth - 1, share)
      children += child
      remaining -= child.length
    }
  }

  return open + children + close
}

/**
 * Generate a single large HTML element of approximately `targetChars` characters.
 * @param {() => number} rng
 * @param {number} targetChars
 * @returns {string}
 */
function generateLargeHtml(rng, targetChars) {
  let inner = ''
  while (inner.length < targetChars) {
    inner += generateElement(rng, 4, Math.min(4000, targetChars - inner.length + 500))
  }
  return `<div class="stress-root">${inner}</div>`
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Collect every element descendant including root.
 * @param {Element} root @returns {Element[]}
 */
const allElements = (root) => [root, .../** @type {Element[]} */ ([...root.querySelectorAll('*')])]

/**
 * Collect every Text node descendant.
 * @param {Element} root @returns {Text[]}
 */
function allTextNodes(root) {
  /** @type {Text[]} */
  const out = []
  const walk = (/** @type {Node} */ node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) out.push(/** @type {Text} */ (child))
      else if (child.nodeType === 1) walk(child)
    }
  }
  walk(root)
  return out
}

/**
 * Walk every character index in the rope and confirm it matches the
 * serialized HTML string. Returns the number of mismatches.
 * @param {NonNullable<ReturnType<typeof buildRope>>} rope
 * @param {string} html
 */
function countIndexMismatches(rope, html) {
  let bad = 0
  for (let i = 0; i < html.length; i++) {
    const r = rope.getAtVisIx(i)
    if (!r || r.node.text[r.offset] !== html[i]) bad++
  }
  return bad
}

/**
 * Call getRange for every element and confirm the HTML slice matches the
 * element's outerHTML. Returns the number of mismatches.
 * @param {NonNullable<ReturnType<typeof buildRope>>} rope
 * @param {Element[]} elements
 * @param {string} html
 */
function countRangeMismatches(rope, elements, html) {
  let bad = 0
  for (const el of elements) {
    const range = rope.getRange(el)
    if (!range) { bad++; continue }
    if (html.slice(range[0], range[1] + 1) !== el.outerHTML) bad++
  }
  return bad
}

/**
 * Call getRange for every Text node and confirm the HTML slice matches its
 * HTML-encoded content. Returns the number of mismatches.
 * @param {NonNullable<ReturnType<typeof buildRope>>} rope
 * @param {Text[]} textNodes
 * @param {string} html
 */
function countTextNodeRangeMismatches(rope, textNodes, html) {
  let bad = 0
  const temp = document.createElement('span')
  for (const textNode of textNodes) {
    const range = rope.getRange(textNode)
    if (!range) { bad++; continue }
    // Get the HTML-escaped version of the text content via the browser
    temp.textContent = ''
    temp.appendChild(textNode.cloneNode(true))
    const expected = temp.innerHTML
    if (html.slice(range[0], range[1] + 1) !== expected) bad++
  }
  return bad
}

/**
 * Check treap structural invariants: heap property, weight correctness, and
 * parent pointer consistency.
 * @param {NonNullable<ReturnType<typeof buildRope>>['root'] | null} node
 * @returns {{ heapViolations: number, weightViolations: number, parentViolations: number }}
 */
function checkTreeInvariants(node) {
  let heapViolations = 0
  let weightViolations = 0
  let parentViolations = 0
  /** @param {NonNullable<ReturnType<typeof buildRope>>['root'] | null} n */
  function walk(n) {
    if (!n) return
    if (n.left  && n.priority < n.left.priority)  heapViolations++
    if (n.right && n.priority < n.right.priority) heapViolations++
    const w = (n.left?.weight ?? 0) + n.text.length + (n.right?.weight ?? 0)
    if (n.weight !== w) weightViolations++
    if (n.left  && n.left.parent  !== n) parentViolations++
    if (n.right && n.right.parent !== n) parentViolations++
    walk(n.left)
    walk(n.right)
  }
  walk(node)
  return { heapViolations, weightViolations, parentViolations }
}

// ---------------------------------------------------------------------------
// Stress tests
// ---------------------------------------------------------------------------

describe('stress', () => {

  it('full index walk and getRange for all elements (~100k chars)', { timeout: 60_000 }, () => {
    const rng = makeRng(42)

    // 1. Generate HTML
    let t = performance.now()
    const rawHtml = generateLargeHtml(rng, 100_000)
    const tGenerate = performance.now() - t

    // 2. Parse into DOM
    t = performance.now()
    const container = document.createElement('div')
    container.innerHTML = rawHtml
    const root = /** @type {Element} */ (container.firstElementChild)
    const tParse = performance.now() - t

    // 3. Build rope
    t = performance.now()
    const rope = mustBuildRope(container)
    const tBuild = performance.now() - t

    const serialized = rope.serialize()

    // Basic sanity
    expect(rope.length).toBe(serialized.length)
    expect(serialized).toBe(container.innerHTML)

    // 4. Walk every character index
    t = performance.now()
    const indexMismatches = countIndexMismatches(rope, serialized)
    const tIndexWalk = performance.now() - t
    expect(indexMismatches).toBe(0)

    // 5. Verify getRange for every element and text node
    const elements  = allElements(root)
    const textNodes = allTextNodes(root)
    t = performance.now()
    const rangeMismatches     = countRangeMismatches(rope, elements, serialized)
    const textRangeMismatches = countTextNodeRangeMismatches(rope, textNodes, serialized)
    const tRangeAll = performance.now() - t
    expect(rangeMismatches).toBe(0)
    expect(textRangeMismatches).toBe(0)

    // 6. Treap invariants (heap, weight, parent pointers)
    const { heapViolations, weightViolations, parentViolations } = checkTreeInvariants(rope.root)
    expect(heapViolations).toBe(0)
    expect(weightViolations).toBe(0)
    expect(parentViolations).toBe(0)

    console.log(`
--- Full Verification Report (seed=42) ---
  HTML chars:         ${serialized.length.toLocaleString()}
  Element count:      ${elements.length.toLocaleString()}
  Text node count:    ${textNodes.length.toLocaleString()}
  generate HTML:      ${tGenerate.toFixed(1)}ms
  parse DOM:          ${tParse.toFixed(1)}ms
  buildRope:          ${tBuild.toFixed(1)}ms
  walk all indices:   ${tIndexWalk.toFixed(1)}ms  (${(tIndexWalk / serialized.length * 1e6).toFixed(0)}ns avg per getAtVisIx)
  getRange all nodes: ${tRangeAll.toFixed(1)}ms  (${(tRangeAll / (elements.length + textNodes.length) * 1000).toFixed(2)}μs avg per getRange)`)
  })

  it('random rebuilds preserve correctness across mutations', { timeout: 60_000 }, () => {
    const rng = makeRng(99)
    const ROUNDS = 15
    const VOID = new Set(['br', 'hr', 'img', 'input'])

    const rawHtml = generateLargeHtml(rng, 50_000)
    const container = document.createElement('div')
    container.innerHTML = rawHtml
    const root = /** @type {Element} */ (container.firstElementChild)
    const rope = mustBuildRope(container)

    const mutable = allElements(root).filter(el => el !== root && !VOID.has(el.tagName.toLowerCase()))

    const rebuildTimes = []
    const verifySizes = []

    for (let round = 0; round < ROUNDS; round++) {
      const target = mutable[Math.floor(rng() * mutable.length)]

      // Alternate between simple text swaps and structural subtree replacements
      if (round % 3 === 0) {
        target.textContent = randomText(rng)
      } else if (round % 3 === 1) {
        target.innerHTML = generateElement(rng, 2, 400)
      } else {
        const el = document.createElement(pick(rng, INLINE_TAGS))
        el.textContent = randomText(rng)
        target.appendChild(el)
      }

      let t = performance.now()
      rope.rebuild(target)
      rebuildTimes.push(performance.now() - t)

      const serialized = rope.serialize()
      verifySizes.push(serialized.length)

      // Serialize must match outerHTML
      expect(serialized).toBe(container.innerHTML)
      expect(rope.length).toBe(serialized.length)

      // Every index must match
      expect(countIndexMismatches(rope, serialized)).toBe(0)

      // Every element and text node range must match
      expect(countRangeMismatches(rope, allElements(root), serialized)).toBe(0)
      expect(countTextNodeRangeMismatches(rope, allTextNodes(root), serialized)).toBe(0)

      // Treap invariants must hold (heap, weight, parent pointers)
      const { heapViolations, weightViolations, parentViolations } = checkTreeInvariants(rope.root)
      expect(heapViolations).toBe(0)
      expect(weightViolations).toBe(0)
      expect(parentViolations).toBe(0)
    }

    const avgRebuild = rebuildTimes.reduce((a, b) => a + b, 0) / rebuildTimes.length
    const maxRebuild = Math.max(...rebuildTimes)
    console.log(`
--- Rebuild Report (seed=99) ---
  Rounds:             ${ROUNDS}
  Final HTML chars:   ${verifySizes[verifySizes.length - 1].toLocaleString()}
  avg rebuild:        ${avgRebuild.toFixed(2)}ms
  max rebuild:        ${maxRebuild.toFixed(2)}ms
  rebuild times:      [${rebuildTimes.map(t => t.toFixed(1)).join(', ')}]ms`)
  })

  it('multiple seeds all produce correct ropes', { timeout: 30_000 }, () => {
    for (const seed of [1, 7, 31, 137, 919, 9999]) {
      const rng = makeRng(seed)
      const rawHtml = generateLargeHtml(rng, 10_000)
      const container = document.createElement('div')
      container.innerHTML = rawHtml
      const root = /** @type {Element} */ (container.firstElementChild)
      const rope = mustBuildRope(container)
      const serialized = rope.serialize()

      expect(serialized).toBe(container.innerHTML)
      expect(rope.length).toBe(serialized.length)
      expect(countIndexMismatches(rope, serialized)).toBe(0)
      expect(countRangeMismatches(rope, allElements(root), serialized)).toBe(0)
      expect(countTextNodeRangeMismatches(rope, allTextNodes(root), serialized)).toBe(0)

      const { heapViolations, weightViolations, parentViolations } = checkTreeInvariants(rope.root)
      expect(heapViolations).toBe(0)
      expect(weightViolations).toBe(0)
      expect(parentViolations).toBe(0)
    }
  })

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('empty elements build, serialize, and index correctly', () => {
    for (const html of ['<div></div>', '<p></p>', '<section></section>', '<span></span>']) {
      const container = document.createElement('div')
      container.innerHTML = html
      const root = /** @type {Element} */ (container.firstElementChild)
      const rope = mustBuildRope(container)
      const serialized = rope.serialize()

      expect(serialized).toBe(container.innerHTML)
      expect(rope.length).toBe(serialized.length)
      expect(countIndexMismatches(rope, serialized)).toBe(0)
      expect(countRangeMismatches(rope, allElements(root), serialized)).toBe(0)

      const { heapViolations, weightViolations, parentViolations } = checkTreeInvariants(rope.root)
      expect(heapViolations).toBe(0)
      expect(weightViolations).toBe(0)
      expect(parentViolations).toBe(0)
    }
  })

  it('rebuild of void element after attribute change', () => {
    const container = document.createElement('div')
    container.innerHTML = '<div><img src="old.png" class="thumb"><br><hr></div>'
    const root = /** @type {Element} */ (container.firstElementChild)
    const img  = /** @type {Element} */ (root.querySelector('img'))
    const rope = mustBuildRope(container)

    img.setAttribute('src', 'new.png')
    img.setAttribute('alt', 'a photo')
    rope.rebuild(img)

    const serialized = rope.serialize()
    expect(serialized).toBe(container.innerHTML)
    expect(countIndexMismatches(rope, serialized)).toBe(0)
    expect(countRangeMismatches(rope, allElements(root), serialized)).toBe(0)
    const { heapViolations, weightViolations, parentViolations } = checkTreeInvariants(rope.root)
    expect(heapViolations).toBe(0)
    expect(weightViolations).toBe(0)
    expect(parentViolations).toBe(0)
  })

  it('rebuilding the same element twice stays correct', () => {
    const container = document.createElement('div')
    container.innerHTML = '<div><p>first</p><span>other</span></div>'
    const root = /** @type {Element} */ (container.firstElementChild)
    const p    = /** @type {Element} */ (root.querySelector('p'))
    const rope = mustBuildRope(container)

    p.textContent = 'second'
    rope.rebuild(p)
    expect(rope.serialize()).toBe(container.innerHTML)
    expect(countIndexMismatches(rope, rope.serialize())).toBe(0)

    p.textContent = 'third'
    rope.rebuild(p)
    expect(rope.serialize()).toBe(container.innerHTML)
    expect(countIndexMismatches(rope, rope.serialize())).toBe(0)

    const { parentViolations } = checkTreeInvariants(rope.root)
    expect(parentViolations).toBe(0)
  })

  it('rebuilding the root element works', () => {
    const container = document.createElement('div')
    container.innerHTML = '<div><p>hello</p></div>'
    const root = /** @type {Element} */ (container.firstElementChild)
    const rope = mustBuildRope(container)

    root.innerHTML = '<section><em>completely different</em></section>'
    rope.rebuild(root)

    const serialized = rope.serialize()
    expect(serialized).toBe(container.innerHTML)
    expect(rope.length).toBe(serialized.length)
    expect(countIndexMismatches(rope, serialized)).toBe(0)
    expect(countRangeMismatches(rope, allElements(root), serialized)).toBe(0)
    const { heapViolations, weightViolations, parentViolations } = checkTreeInvariants(rope.root)
    expect(heapViolations).toBe(0)
    expect(weightViolations).toBe(0)
    expect(parentViolations).toBe(0)
  })

  it('split-within-text is unreachable via the public API', () => {
    // rebuild() always splits at exact rope-node boundaries:
    //   split 1: computeStart(openNode)                     ← start of a rope node
    //   split 2: computeStart(closeNode) + closeNode.length ← end of a rope node
    // So the within-text branch of split() is dead code for all public usage.
    // This test documents that invariant by verifying rebuild correctness across
    // a range of element sizes and positions, any of which would expose a faulty
    // split if the boundary assumption were wrong.
    const rng = makeRng(777)
    const container = document.createElement('div')
    container.innerHTML = generateLargeHtml(rng, 5_000)
    const root = /** @type {Element} */ (container.firstElementChild)
    const rope = mustBuildRope(container)
    const VOID = new Set(['br', 'hr', 'img', 'input'])
    const targets = allElements(root).filter(el => !VOID.has(el.tagName.toLowerCase()))

    for (let i = 0; i < 20; i++) {
      const target = targets[Math.floor(rng() * targets.length)]
      // Skip targets a prior iteration's textContent reset already detached — they
      // aren't in the DOM or the rope, so there's nothing (and no valid anchor) to rebuild.
      if (!container.contains(target)) continue
      target.textContent = randomText(rng)
      rope.rebuild(target)
      expect(rope.serialize()).toBe(container.innerHTML)
      const { parentViolations } = checkTreeInvariants(rope.root)
      expect(parentViolations).toBe(0)
    }
  })

  // ---------------------------------------------------------------------------
  // Fuzz: range rebuild — rope.rebuild(start, end) across a sibling span while
  // nodes are inserted/deleted/edited *between* the two boundaries. The
  // single-element rebuild fuzz above never moves sibling structure; this one
  // does, which is the code path the scoped sync layer relies on.
  // ---------------------------------------------------------------------------

  /** Parse a random standalone element (kept small, valid inside a block). */
  function makeElement(/** @type {() => number} */ rng) {
    const tmp = document.createElement('div')
    tmp.innerHTML = generateElement(rng, randInt(rng, 0, 2), randInt(rng, 40, 300))
    return /** @type {Element} */ (tmp.firstElementChild)
  }

  /**
   * Full consistency assertion. `elements`/`textNodes` are the nodes the rope is
   * expected to track — every one must resolve. (For a standalone root that's
   * `allElements(root)`; for the editor path it's the root's descendants only,
   * since the editor element itself isn't in the rope.)
   * @param {any} rope
   * @param {Element[]} elements
   * @param {Text[]} textNodes
   * @param {string} expectedHtml
   */
  function assertConsistent(rope, elements, textNodes, expectedHtml) {
    const html = rope.serialize()
    expect(html).toBe(expectedHtml)
    expect(rope.length).toBe(html.length)
    expect(countIndexMismatches(rope, html)).toBe(0)
    expect(countRangeMismatches(rope, elements, html)).toBe(0)
    expect(countTextNodeRangeMismatches(rope, textNodes, html)).toBe(0)
    const { heapViolations, weightViolations, parentViolations } = checkTreeInvariants(rope.root)
    expect(heapViolations).toBe(0)
    expect(weightViolations).toBe(0)
    expect(parentViolations).toBe(0)
  }

  it('range rebuild: random interior inserts/deletes/edits stay correct', { timeout: 30_000 }, () => {
    for (const seed of [3, 29, 211, 1013, 65537]) {
      const rng = makeRng(seed)
      const container = document.createElement('div')
      container.innerHTML = generateLargeHtml(rng, 6_000)
      const root = /** @type {Element} */ (container.firstElementChild)
      const rope = mustBuildRope(container)

      for (let round = 0; round < 40; round++) {
        const kids = /** @type {Element[]} */ ([...root.children])
        if (kids.length < 2) break // exhausted — nothing left to range over

        // Pick an ordered boundary pair; they must survive the round so
        // rebuild() can anchor on them (its documented precondition).
        const i = randInt(rng, 0, kids.length - 1)
        const j = randInt(rng, i, kids.length - 1)
        const start = kids[i]
        const end   = kids[j]

        // Mutate the interior (strictly between the boundaries): delete some,
        // insert some, replace some subtrees. Also occasionally edit a boundary.
        for (let k = i + 1; k < j; k++) {
          const roll = rng()
          if (roll < 0.35) root.removeChild(kids[k])
          else if (roll < 0.6) kids[k].innerHTML = generateElement(rng, 1, 200)
        }
        // Only insert when there's room strictly inside the range: inserting
        // before `end` when start === end would land *outside* [start, end] and
        // rebuild(start, start) wouldn't rebuild it.
        if (j > i) {
          const inserts = randInt(rng, 0, 3)
          for (let n = 0; n < inserts; n++) {
            const node = makeElement(rng)
            if (node) root.insertBefore(node, end) // lands inside (start, end]
          }
        }
        if (rng() < 0.5) start.textContent = randomText(rng)
        if (rng() < 0.5 && end !== start) end.textContent = randomText(rng)

        // One range rebuild absorbs every change in the span.
        rope.rebuild(start, end)
        assertConsistent(rope, allElements(root), allTextNodes(root), container.innerHTML)
      }
    }
  })

  // ---------------------------------------------------------------------------
  // Fuzz: the sync layer's scoped path end-to-end. Random *in-place* DOM edits
  // (not wholesale innerHTML sets, which take the full-doc path) drive the
  // observer → localRegion → diffToCrdt → incremental rebuild pipeline.
  // Verifies the *live* rope (patched incrementally) and that the CRDT actually
  // converged to the DOM — i.e. the resolved scope wasn't too narrow.
  // ---------------------------------------------------------------------------

  const flush = () => new Promise((r) => setTimeout(r, 0))

  /** Apply one random in-place edit to a top-level block of the editor `el`. */
  function randomInPlaceEdit(/** @type {() => number} */ rng, /** @type {Element} */ el) {
    const kids = /** @type {Element[]} */ ([...el.children])
    const choice = randInt(rng, 0, 5)
    if (choice === 0 && kids.length > 0) {
      // Edit a block's text in place → characterData mutation.
      const p = pick(rng, kids)
      const first = p.firstChild
      if (first && first.nodeType === 3) /** @type {Text} */ (first).data = randomText(rng)
      else p.textContent = randomText(rng)
    } else if (choice === 1 && kids.length > 1) {
      // Remove a block (leave at least one) → childList mutation.
      pick(rng, kids).remove()
    } else if (choice === 2) {
      // Insert a new block at a random position → childList mutation.
      const p = document.createElement('p')
      p.textContent = randomText(rng)
      el.insertBefore(p, kids.length ? pick(rng, kids) : null)
    } else if (choice === 3 && kids.length > 0) {
      // Real (non-internal) attribute edit → attributes mutation.
      pick(rng, kids).setAttribute('data-note', randomAttrValue(rng))
    } else if (choice === 4 && kids.length > 0) {
      // Replace a block with a fresh-identity clone of *identical* content —
      // mirrors TinyMCE churning chrome nodes. Content matches, so the full-doc
      // path early-returns without rebuilding the rope, leaving a stale identity
      // tracked and the new node untracked: the setup for a null-endEl scoped diff.
      const victim = pick(rng, kids)
      victim.replaceWith(victim.cloneNode(true))
    } else if (kids.length > 0) {
      // Append inline content inside a block → nested childList mutation.
      const span = document.createElement('span')
      span.textContent = randomText(rng)
      pick(rng, kids).appendChild(span)
    }
  }

  /** Fresh contenteditable editor attached to the document. */
  function makeEditorEl() {
    const el = document.createElement('div')
    el.setAttribute('contenteditable', 'true')
    document.body.appendChild(el)
    return el
  }

  const SEED_HTML = '<p>alpha one</p><p>beta two</p><p>gamma three</p><p>delta four</p>'

  it('sync layer: random in-place edits keep the live rope + CRDT consistent', { timeout: 30_000 }, async () => {
    for (const seed of [5, 97, 4099]) {
      const rng = makeRng(seed)
      const el = makeEditorEl()
      await createRogueNode({ element: el })
      const api = /** @type {any} */ (window).rogue

      el.innerHTML = SEED_HTML
      await flush()

      for (let round = 0; round < 50; round++) {
        randomInPlaceEdit(rng, el)
        await flush()

        const live = api.rope()
        if (el.innerHTML === '') {
          expect(live).toBeNull()
          continue
        }
        expect(live).not.toBeNull()
        // Live rope (incrementally patched) matches the DOM. The editor element
        // itself isn't in the rope, so check its descendants only.
        assertConsistent(live, [...el.querySelectorAll('*')], allTextNodes(el), el.innerHTML)
        // ...and node identity is preserved (fresh build over the same DOM).
        expect(live.serialize()).toBe(mustBuildRope(el).serialize())
        // The CRDT converged to the DOM — the resolved scope covered the change.
        expect(api.render()).toBe(el.innerHTML)
      }
    }
  })

  // Path 2 counterpart: the same random edits made on one node are gossiped as
  // ops to a second node, whose mergeOp path (opRegion → DOM swap →
  // incremental rope.rebuild on the surviving neighbours) must keep the receiver
  // converged and its *live* rope consistent.
  it('sync layer: mergeOp keeps the receiver live rope + DOM consistent', { timeout: 30_000 }, async () => {
    for (const seed of [11, 251, 7919]) {
      const rng = makeRng(seed)
      const el1 = makeEditorEl()
      const el2 = makeEditorEl()
      let node2 = /** @type {any} */ (null)
      // node1 gossips its ops into node2; node2 is created last so window.rogue
      // (the debug handle we read the live rope from) points at the receiver.
      await createRogueNode({ element: el1, onCommit: (p) => node2.mergeOp(p) })
      node2 = await createRogueNode({ element: el2 })
      const api = /** @type {any} */ (window).rogue

      el1.innerHTML = SEED_HTML
      await flush()

      for (let round = 0; round < 50; round++) {
        randomInPlaceEdit(rng, el1)
        await flush() // node1 syncs → emits op → node2.mergeOp

        // Receiver converged to the sender, and its live rope is consistent.
        expect(el2.innerHTML).toBe(el1.innerHTML)
        const live = api.rope()
        if (el2.innerHTML === '') {
          expect(live).toBeNull()
          continue
        }
        expect(live).not.toBeNull()
        assertConsistent(live, [...el2.querySelectorAll('*')], allTextNodes(el2), el2.innerHTML)
        expect(live.serialize()).toBe(mustBuildRope(el2).serialize())
      }
    }
  })

})
