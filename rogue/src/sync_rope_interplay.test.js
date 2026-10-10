// @ts-check
/**
 * Integration tests for the interplay between the CRDT sync layer and DomRope.
 *
 * Covered here (not in sync.test.js or dom_rope.stress.test.js):
 *   A. Multi-step editing sessions — rope verified after every edit
 *   B. Two-node sync round-trips — rope verified on both sides throughout
 *   C. rope.rebuild() after partial DOM updates — matches fresh buildRope()
 *   D. Cursor/position tracking — getAtVisIx/getRange across inserts and deletes
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createRogueNode } from './sync.js'
import { buildRope } from './dom_rope.js'
import { mustBuildRope } from './test-helpers.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** @returns {HTMLElement} */
function makeEditor() {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  document.body.appendChild(el)
  return el
}

/** Let the engine's MutationObserver deliver + process pending mutations. */
const flush = () => new Promise((r) => setTimeout(r, 0))

/**
 * Simulate a user edit: set innerHTML, then let the observer sync.
 * @param {HTMLElement} el
 * @param {string} html
 */
async function type(el, html) {
  el.innerHTML = html
  await flush()
}

/**
 * Assert that a rope is fully consistent with its host element:
 *   - serialize() matches innerHTML
 *   - weight equals serialized length
 *   - every character index resolves correctly
 *   - getRange for every element and text node is correct
 *   - treap heap + weight + parent invariants hold
 *
 * @param {HTMLElement} el
 */
function assertRopeConsistency(el) {
  const rope = buildRope(el)

  // Empty document — nothing to verify
  if (!rope) {
    expect(el.innerHTML).toBe('')
    return null
  }

  const html = rope.serialize()

  expect(html).toBe(el.innerHTML)
  expect(rope.length).toBe(html.length)

  // Every character index resolves to the right character
  for (let i = 0; i < html.length; i++) {
    const r = rope.getAtVisIx(i)
    expect(r).not.toBeNull()
    expect(r?.node.text[r.offset]).toBe(html[i])
  }

  // getRange for every element (not the editor itself) maps back to the correct outerHTML slice
  for (const child of el.querySelectorAll('*')) {
    const range = rope.getRange(child)
    expect(range).not.toBeNull()
    if (range) {
      expect(html.slice(range[0], range[1] + 1)).toBe(
        /** @type {Element} */ (child).outerHTML,
      )
    }
  }

  // getRange for every text node maps back to the correct escaped text
  const temp = document.createElement('span')
  for (const textNode of allTextNodes(el)) {
    const range = rope.getRange(textNode)
    expect(range).not.toBeNull()
    if (range) {
      temp.textContent = ''
      temp.appendChild(textNode.cloneNode(true))
      expect(html.slice(range[0], range[1] + 1)).toBe(temp.innerHTML)
    }
  }

  // Treap structural invariants
  checkTreeInvariants(rope.root)

  return rope
}

/**
 * @param {Element} root
 * @returns {Text[]}
 */
function allTextNodes(root) {
  /** @type {Text[]} */
  const out = []
  const walk = (/** @type {Node} */ n) => {
    for (const child of n.childNodes) {
      if (child.nodeType === 3) out.push(/** @type {Text} */ (child))
      else if (child.nodeType === 1) walk(child)
    }
  }
  walk(root)
  return out
}

/**
 * @param {import('./dom_rope.js').RopeNode | null} node
 */
function checkTreeInvariants(node) {
  if (!node) return
  if (node.left)  expect(node.priority).toBeGreaterThanOrEqual(node.left.priority)
  if (node.right) expect(node.priority).toBeGreaterThanOrEqual(node.right.priority)
  const w = (node.left?.weight ?? 0) + node.text.length + (node.right?.weight ?? 0)
  expect(node.weight).toBe(w)
  if (node.left)  expect(node.left.parent).toBe(node)
  if (node.right) expect(node.right.parent).toBe(node)
  checkTreeInvariants(node.left)
  checkTreeInvariants(node.right)
}

// ---------------------------------------------------------------------------
// A. Multi-step editing sessions
// ---------------------------------------------------------------------------

describe('A. multi-step editing sessions', () => {

  it('10 sequential edits to different positions — rope correct after each', async () => {
    const el = makeEditor()
    await createRogueNode({ element: el })

    const edits = [
      'hello',
      'hello world',
      'hello beautiful world',
      'hello beautiful world!',
      'hi beautiful world!',
      'hi world!',
      'hi world! how are you',
      'hi world! how are you?',
      'hi. how are you?',
      'hi.',
    ]

    for (const html of edits) {
      await type(el, html)
      assertRopeConsistency(el)
    }
  })

  it('structured HTML: editing different paragraphs in sequence', async () => {
    const el = makeEditor()
    await createRogueNode({ element: el })

    // Build up a multi-paragraph document step by step
    const stages = [
      '<p>First paragraph.</p>',
      '<p>First paragraph.</p><p>Second paragraph.</p>',
      '<p>First paragraph.</p><p>Second paragraph.</p><p>Third paragraph.</p>',
      // Edit first paragraph
      '<p>First paragraph, edited.</p><p>Second paragraph.</p><p>Third paragraph.</p>',
      // Edit last paragraph
      '<p>First paragraph, edited.</p><p>Second paragraph.</p><p>Third paragraph, also edited.</p>',
      // Edit middle paragraph
      '<p>First paragraph, edited.</p><p>Second paragraph — now longer with more words.</p><p>Third paragraph, also edited.</p>',
      // Remove first paragraph
      '<p>Second paragraph — now longer with more words.</p><p>Third paragraph, also edited.</p>',
      // Add a new last paragraph
      '<p>Second paragraph — now longer with more words.</p><p>Third paragraph, also edited.</p><p>New final paragraph.</p>',
    ]

    for (const html of stages) {
      await type(el, html)
      assertRopeConsistency(el)
    }
  })

  it('interleaved adds and deletes preserve rope integrity', async () => {
    const el = makeEditor()
    await createRogueNode({ element: el })

    await type(el, 'aaa bbb ccc ddd eee')
    assertRopeConsistency(el)

    await type(el, 'aaa XXX ccc ddd eee')   // replace middle word
    assertRopeConsistency(el)

    await type(el, 'aaa XXX ccc eee')        // delete a word
    assertRopeConsistency(el)

    await type(el, 'ZZZ aaa XXX ccc eee')    // prepend
    assertRopeConsistency(el)

    await type(el, 'ZZZ aaa XXX ccc eee YYY') // append
    assertRopeConsistency(el)

    await type(el, 'clean slate')             // wholesale replace
    assertRopeConsistency(el)

    await type(el, '')                        // clear
    assertRopeConsistency(el)
  })

  it('undo followed by re-edit leaves rope consistent', async () => {
    const el = makeEditor()
    const node = await createRogueNode({ element: el })

    await type(el, 'step one')
    assertRopeConsistency(el)

    await type(el, 'step one and two')
    assertRopeConsistency(el)

    node.undo()
    assertRopeConsistency(el)

    await type(el, 'step one and three')
    assertRopeConsistency(el)

    node.undo()
    assertRopeConsistency(el)

    node.undo()
    assertRopeConsistency(el)
  })

})

// ---------------------------------------------------------------------------
// B. Two-node sync round-trips
// ---------------------------------------------------------------------------

describe('B. two-node sync round-trips', () => {

  /** @type {HTMLElement} */
  let el1
  /** @type {HTMLElement} */
  let el2
  /** @type {import('./sync.js').RogueNode} */
  let node1
  /** @type {import('./sync.js').RogueNode} */
  let node2
  /** @type {Uint8Array[]} */
  let ops1
  /** @type {Uint8Array[]} */
  let ops2

  beforeEach(async () => {
    el1 = makeEditor()
    el2 = makeEditor()
    ops1 = []
    ops2 = []
    node1 = await createRogueNode({ element: el1, onCommit(p) { ops1.push(p) } })
    node2 = await createRogueNode({ element: el2, onCommit(p) { ops2.push(p) } })
  })

  /** Drain all pending ops from node1 into node2 and vice-versa. */
  function sync() {
    const from1 = ops1.splice(0)
    const from2 = ops2.splice(0)
    for (const op of from1) node2.mergeOp(op)
    for (const op of from2) node1.mergeOp(op)
  }

  it('after every sync both nodes have identical content and valid ropes', async () => {
    await type(el1, 'hello from node1')
    sync()
    expect(el2.innerHTML).toBe(el1.innerHTML)
    assertRopeConsistency(el1)
    assertRopeConsistency(el2)

    await type(el2, 'hello from node2')
    sync()
    expect(el1.innerHTML).toBe(el2.innerHTML)
    assertRopeConsistency(el1)
    assertRopeConsistency(el2)
  })

  it('five alternating edits: rope consistent on both sides at every step', async () => {
    const sequence = [
      { node: 1, html: 'edit A' },
      { node: 2, html: 'edit B' },
      { node: 1, html: 'edit C — longer content now' },
      { node: 2, html: 'edit D' },
      { node: 1, html: 'edit E, final' },
    ]

    for (const step of sequence) {
      await type(step.node === 1 ? el1 : el2, step.html)
      sync()
      expect(el1.innerHTML).toBe(el2.innerHTML)
      assertRopeConsistency(el1)
      assertRopeConsistency(el2)
    }
  })

  it('structured HTML syncs and rope is correct on receiving end', async () => {
    const stages = [
      '<p>paragraph one</p><p>paragraph two</p>',
      '<p>paragraph one edited</p><p>paragraph two</p>',
      '<p>paragraph one edited</p><p>paragraph two edited</p>',
    ]

    for (const html of stages) {
      await type(el1, html)
      sync()
      expect(el2.innerHTML).toBe(el1.innerHTML)
      assertRopeConsistency(el2)
    }
  })

  it('ten-round ping-pong: HTML and rope stay consistent throughout', async () => {
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon',
                   'zeta', 'eta', 'theta', 'iota', 'kappa']

    for (let i = 0; i < words.length; i++) {
      const el = i % 2 === 0 ? el1 : el2
      await type(el, words.slice(0, i + 1).join(' '))
      sync()
      expect(el1.innerHTML).toBe(el2.innerHTML)
      assertRopeConsistency(el1)
      assertRopeConsistency(el2)
    }
  })

})

// ---------------------------------------------------------------------------
// C. rope.rebuild() after partial DOM updates
// ---------------------------------------------------------------------------

describe('C. rope.rebuild() after partial updates', () => {

  it('rebuild() on a changed element matches fresh buildRope()', async () => {
    const el = makeEditor()
    await createRogueNode({ element: el })

    await type(el, '<p>paragraph one</p><p>paragraph two</p><p>paragraph three</p>')
    const rope = mustBuildRope(el)

    // Mutate the second paragraph (simulating a CRDT-driven partial update)
    const p2 = /** @type {Element} */ (el.querySelectorAll('p')[1])
    p2.textContent = 'paragraph two — updated by CRDT'
    rope.rebuild(p2)

    // Rebuilt rope must match both the fresh rope and the live DOM
    const freshRope = mustBuildRope(el)
    expect(rope.serialize()).toBe(el.innerHTML)
    expect(rope.serialize()).toBe(freshRope.serialize())
    checkTreeInvariants(rope.root)
  })

  it('rebuild() preserves correctness for untouched siblings', async () => {
    const el = makeEditor()
    await createRogueNode({ element: el })

    await type(el, '<p>one</p><p>two</p><p>three</p>')
    const rope = mustBuildRope(el)

    const paragraphs = el.querySelectorAll('p')
    const p1 = /** @type {Element} */ (paragraphs[0])
    const p3 = /** @type {Element} */ (paragraphs[2])

    // Record ranges for untouched siblings before mutation
    const rangeP3Before = rope.getRange(p3)

    // Mutate only the first paragraph
    p1.textContent = 'one — much longer now with many more words'
    rope.rebuild(p1)

    const html = rope.serialize()
    expect(html).toBe(el.innerHTML)

    // p3's range should have shifted by the length change in p1
    const rangeP3After = rope.getRange(p3)
    expect(rangeP3After).not.toBeNull()
    if (rangeP3Before && rangeP3After) {
      const shift = rangeP3After[0] - rangeP3Before[0]
      const lengthDelta = p1.outerHTML.length - '<p>one</p>'.length
      expect(shift).toBe(lengthDelta)
    }

    // Every index still correct after the shift
    for (let i = 0; i < html.length; i++) {
      const r = rope.getAtVisIx(i)
      expect(r?.node.text[r.offset]).toBe(html[i])
    }
  })

  it('multiple sequential rebuilds accumulate correctly', async () => {
    const el = makeEditor()
    await createRogueNode({ element: el })

    await type(el, '<p>a</p><p>b</p><p>c</p><p>d</p><p>e</p>')
    const rope = mustBuildRope(el)
    const ps = /** @type {Element[]} */ ([...el.querySelectorAll('p')])

    // Mutate and rebuild each paragraph in turn
    for (let i = 0; i < ps.length; i++) {
      ps[i].textContent = `paragraph ${i + 1} with more text`
      rope.rebuild(ps[i])
      expect(rope.serialize()).toBe(el.innerHTML)
      checkTreeInvariants(rope.root)
    }
  })

  it('rebuild() models a cursor-preserving partial update', async () => {
    // This test shows the intended use pattern for cursor preservation:
    // instead of replacing the whole innerHTML (which discards DOM node identity),
    // mutate specific subtrees and call rebuild() to keep node references alive.
    const el = makeEditor()
    await createRogueNode({ element: el })

    await type(el, '<p>first</p><p>second</p><p>third</p>')
    const rope = mustBuildRope(el)

    // Grab references to all three paragraphs — these stay alive across rebuild()
    const [p1, p2, p3] = /** @type {Element[]} */ ([...el.querySelectorAll('p')])

    // Simulate what a cursor-preserving sync would do: mutate only the changed
    // subtree instead of replacing the whole innerHTML.
    p2.textContent = 'second — updated'
    rope.rebuild(p2)

    // Rope is correct and p1/p3 node references are still valid
    expect(rope.serialize()).toBe(el.innerHTML)
    expect(rope.getRange(p1)).not.toBeNull()
    expect(rope.getRange(p3)).not.toBeNull()
    checkTreeInvariants(rope.root)

    // If instead we had used innerHTML = newHtml, p1/p3 refs would be stale —
    // this is the key difference between rebuild() and full replacement.
    const staleP1 = p1
    el.innerHTML = el.innerHTML.replace('second — updated', 'second — replaced via innerHTML')
    const freshRope = mustBuildRope(el)
    // staleP1 is no longer in the live DOM after innerHTML replacement
    expect(freshRope.getRange(staleP1)).toBeNull()
  })

  it('rebuild(start, end) patches a multi-sibling range with interior add/delete', async () => {
    const el = makeEditor()
    await createRogueNode({ element: el })

    await type(el, '<p>a</p><p>b</p><p>c</p><p>d</p>')
    const rope = mustBuildRope(el)
    const pA = /** @type {Element} */ (el.firstElementChild)
    const pD = /** @type {Element} */ (el.lastElementChild)

    // In-place edits spanning the range while keeping the pA/pD boundaries alive:
    // delete an interior block, insert a new one, and edit the trailing block.
    el.children[1].remove() // drop <p>b</p>  → [a, c, d]
    const pNew = document.createElement('p')
    pNew.textContent = 'x'
    el.insertBefore(pNew, pD) // → [a, c, x, d]
    const pdText = /** @type {Text} */ (pD.firstChild)
    pdText.data = 'D!'

    // One range rebuild absorbs the delete, the insert, and the boundary edit.
    rope.rebuild(pA, pD)

    expect(rope.serialize()).toBe(el.innerHTML)
    expect(rope.serialize()).toBe('<p>a</p><p>c</p><p>x</p><p>D!</p>')
    expect(rope.serialize()).toBe(mustBuildRope(el).serialize())
    checkTreeInvariants(rope.root)
  })

  // The engine's persistent rope is patched incrementally (rope.rebuild) on the
  // scoped sync path rather than fully rebuilt. These edits are in-place DOM
  // mutations (not wholesale innerHTML sets, which take the full-doc path), so
  // they exercise the incremental path and its effect on the *live* rope.
  it('live rope stays consistent through in-place scoped edits', async () => {
    const el = makeEditor()
    await createRogueNode({ element: el })

    /** Assert the engine's live (incrementally-patched) rope is fully correct. */
    const assertLiveRope = () => {
      const live = /** @type {any} */ (window).rogue.rope()
      expect(live).not.toBeNull()
      expect(live.serialize()).toBe(el.innerHTML)
      expect(live.serialize()).toBe(mustBuildRope(el).serialize())
      checkTreeInvariants(live.root)
    }

    await type(el, '<p>one</p><p>two</p><p>three</p>') // initial: full-doc build
    assertLiveRope()

    // Edit a block's text in place → characterData mutation → scoped rebuild.
    const firstText = /** @type {Text} */ (el.children[0].firstChild)
    firstText.data = 'one!'
    await flush()
    expect(el.innerHTML).toBe('<p>one!</p><p>two</p><p>three</p>')
    assertLiveRope()

    // Remove a middle block → childList mutation, bracketed by surviving siblings.
    el.children[1].remove()
    await flush()
    expect(el.innerHTML).toBe('<p>one!</p><p>three</p>')
    assertLiveRope()

    // Insert a new block between survivors → the new node joins the rope span.
    const mid = document.createElement('p')
    mid.textContent = 'mid'
    el.insertBefore(mid, el.children[1])
    await flush()
    expect(el.innerHTML).toBe('<p>one!</p><p>mid</p><p>three</p>')
    assertLiveRope()
  })

})

// ---------------------------------------------------------------------------
// D. Cursor / position tracking across edits
// ---------------------------------------------------------------------------

describe('D. cursor position tracking', () => {

  it('getAtVisIx is stable at a fixed offset after appending content', async () => {
    const el = makeEditor()
    await createRogueNode({ element: el })

    await type(el, '<p>hello</p><p>world</p>')
    const rope1 = mustBuildRope(el)

    // Grab the node at position 3 (inside '<p>' open tag of first paragraph)
    const r1 = rope1.getAtVisIx(3)
    expect(r1).not.toBeNull()
    const domNode1 = r1?.node.domNode

    // Append a new paragraph at the end — this shifts nothing before it
    await type(el, '<p>hello</p><p>world</p><p>appended</p>')
    const rope2 = mustBuildRope(el)

    // Position 3 should still be in the same node (nothing before it changed)
    const r2 = rope2.getAtVisIx(3)
    expect(r2?.node.kind).toBe(r1?.node.kind)
    // The domNode may be a new object (innerHTML replacement), but the
    // kind and offset within the first paragraph are stable
    expect(r2?.offset).toBe(r1?.offset)
  })

  it('getRange shift: inserting before a node pushes its start forward', async () => {
    const el = makeEditor()
    await createRogueNode({ element: el })

    await type(el, '<p>target</p>')
    const rope1 = mustBuildRope(el)
    const p = el.querySelector('p')
    const range1 = rope1.getRange(/** @type {Element} */ (p))
    expect(range1).not.toBeNull()

    // Prepend content — this pushes the target paragraph right
    await type(el, '<p>prefix</p><p>target</p>')
    const rope2 = mustBuildRope(el)
    const p2 = /** @type {Element[]} */ ([...el.querySelectorAll('p')])[1]
    const range2 = rope2.getRange(p2)
    expect(range2).not.toBeNull()

    if (range1 && range2) {
      // target paragraph starts after '<p>prefix</p>' which is 13 chars
      expect(range2[0]).toBe(range1[0] + '<p>prefix</p>'.length)
    }
  })

  it('getRange shift: deleting before a node pulls its start backward', async () => {
    const el = makeEditor()
    await createRogueNode({ element: el })

    await type(el, '<p>prefix</p><p>target</p>')
    const rope1 = mustBuildRope(el)
    const psBefore = /** @type {Element[]} */ ([...el.querySelectorAll('p')])
    const range1 = rope1.getRange(psBefore[1])

    // Remove the prefix paragraph
    await type(el, '<p>target</p>')
    const rope2 = mustBuildRope(el)
    const range2 = rope2.getRange(/** @type {Element} */ (el.querySelector('p')))

    if (range1 && range2) {
      expect(range2[0]).toBe(range1[0] - '<p>prefix</p>'.length)
    }
  })

  it('cursor lands in the right element after a local insert before cursor position', async () => {
    const el = makeEditor()
    await createRogueNode({ element: el })

    // Step 1: document has "hello world"
    await type(el, 'hello world')
    const rope1 = mustBuildRope(el)
    const html1 = rope1.serialize()
    const worldBefore = html1.indexOf('world')
    expect(worldBefore).toBeGreaterThan(0)

    // Step 2: insert " beautiful" between "hello" and "world"
    await type(el, 'hello beautiful world')
    const rope2 = mustBuildRope(el)
    const html2 = rope2.serialize()
    const worldAfter = html2.indexOf('world')

    // "world" should have shifted right by " beautiful".length
    expect(worldAfter - worldBefore).toBe(' beautiful'.length)

    // getAtVisIx at the old "world" position now lands inside "beautiful"
    // (DMP inserts "beautiful " before 'w'; the space preceding it was already there)
    const atOldWorld = rope2.getAtVisIx(worldBefore)
    expect(atOldWorld).not.toBeNull()
    expect(atOldWorld?.node.text[atOldWorld.offset]).toBe('b')

    // getAtVisIx at the new "world" position correctly resolves to 'w'
    const atNewWorld = rope2.getAtVisIx(worldAfter)
    expect(atNewWorld?.node.text[atNewWorld.offset]).toBe('w')
  })

  it('full index walk after each step of a 5-step session', async () => {
    const el = makeEditor()
    await createRogueNode({ element: el })

    const steps = [
      'a',
      'ab',
      'abc',
      'aXc',
      'aXcY',
    ]

    for (const html of steps) {
      await type(el, html)
      const rope = mustBuildRope(el)
      const serialized = rope.serialize()
      for (let i = 0; i < serialized.length; i++) {
        const r = rope.getAtVisIx(i)
        expect(r?.node.text[r.offset]).toBe(serialized[i])
      }
    }
  })

})
