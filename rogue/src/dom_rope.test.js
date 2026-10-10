// @ts-check
import { describe, it, expect, beforeEach } from 'vitest'
import { buildRope, escapeText } from './dom_rope.js'
/** @import { RopeNode } from './dom_rope.js' */

/**
 * Parse an HTML string into a wrapper div whose innerHTML is that HTML.
 * Pass this div to buildRope() so the rope covers innerHTML (not outerHTML).
 * @param {string} html
 * @returns {HTMLDivElement}
 */
function el(html) {
  const div = document.createElement('div')
  div.innerHTML = html
  return div
}

/**
 * Collect all treap nodes in in-order (= document order).
 * @param {RopeNode | null} node
 * @param {RopeNode[]} [out]
 * @returns {RopeNode[]}
 */
function inOrder(node, out = []) {
  if (!node) return out
  inOrder(node.left, out)
  out.push(node)
  inOrder(node.right, out)
  return out
}

// ---------------------------------------------------------------------------
// serialize
// ---------------------------------------------------------------------------

describe('serialize', () => {
  it('round-trips plain text', () => {
    expect(buildRope(el('<p>hello</p>'))?.serialize()).toBe('<p>hello</p>')
  })

  it('round-trips nested elements', () => {
    expect(buildRope(el('<b>hello<u> world</u></b>'))?.serialize()).toBe('<b>hello<u> world</u></b>')
  })

  it('round-trips element attributes', () => {
    expect(buildRope(el('<a href="https://example.com" class="link">click</a>'))?.serialize())
      .toBe('<a href="https://example.com" class="link">click</a>')
  })

  it('escapes & < > in text', () => {
    const wrapper = el('<p></p>')
    const p = /** @type {Element} */ (wrapper.firstElementChild)
    p.textContent = 'a & b < c > d'
    expect(buildRope(wrapper)?.serialize()).toBe('<p>a &amp; b &lt; c &gt; d</p>')
  })

  it('round-trips void elements', () => {
    expect(buildRope(el('<div>before<br>after</div>'))?.serialize()).toBe('<div>before<br>after</div>')
  })

  it('round-trips img with attributes', () => {
    expect(buildRope(el('<div><img src="cat.png" alt="a cat"></div>'))?.serialize())
      .toBe('<div><img src="cat.png" alt="a cat"></div>')
  })

  it('round-trips deeply nested structure', () => {
    const html = '<div><p><span><em>deep</em></span></p></div>'
    expect(buildRope(el(html))?.serialize()).toBe(html)
  })

  it('round-trips empty element', () => {
    expect(buildRope(el('<div></div>'))?.serialize()).toBe('<div></div>')
  })

  it('round-trips multiple children', () => {
    const html = '<ul><li>one</li><li>two</li><li>three</li></ul>'
    expect(buildRope(el(html))?.serialize()).toBe(html)
  })
})

// ---------------------------------------------------------------------------
// escapeText / escapeTextOffset (shared ENTITIES table)
// ---------------------------------------------------------------------------

describe('escapeText', () => {
  it('escapes & < > and U+00A0 to their HTML entities', () => {
    expect(escapeText('a & b < c > d \u00A0 e')).toBe('a &amp; b &lt; c &gt; d &nbsp; e')
  })

  it('strips the U+FEFF caret placeholder', () => {
    expect(escapeText('a\uFEFFb')).toBe('ab')
    expect(escapeText('\uFEFF')).toBe('')
  })

  it('escapes & before < and > so &lt;/&gt; are not re-escaped', () => {
    expect(escapeText('<&')).toBe('&lt;&amp;')
  })
})

describe('domPosToVisIx / visIxToDomPos inverse (escaped text)', () => {
  it('round-trips every interior raw offset through the escaped index', () => {
    const wrapper = el('<p></p>')
    const p = /** @type {Element} */ (wrapper.firstElementChild)
    p.textContent = 'a&b<c>\u00A0d'
    const rope = buildRope(wrapper)
    if (!rope) throw new Error('rope build failed')
    const t = /** @type {Text} */ (p.firstChild)
    // Interior offsets only: the end-of-text position resolves to the parent's
    // close node, not the text node (a deliberate rope boundary convention).
    for (let r = 0; r < t.data.length; r++) {
      const vis = rope.domPosToVisIx(t, r)
      if (vis === null) throw new Error(`domPosToVisIx null at ${r}`)
      const back = rope.visIxToDomPos(vis)
      if (!back) throw new Error(`visIxToDomPos null at vis ${vis}`)
      expect(back.node).toBe(t)
      expect(back.offset).toBe(r)
    }
  })

  it('collapses the U+FEFF placeholder to zero index width', () => {
    const wrapper = el('<p></p>')
    const p = /** @type {Element} */ (wrapper.firstElementChild)
    p.textContent = 'a\uFEFFb'
    const rope = buildRope(wrapper)
    if (!rope) throw new Error('rope build failed')
    const t = /** @type {Text} */ (p.firstChild)
    expect(rope.domPosToVisIx(t, 1)).toBe(rope.domPosToVisIx(t, 2))
  })
})

// ---------------------------------------------------------------------------
// serializeNode hook (host-driven clean serialization)
// ---------------------------------------------------------------------------

describe('serializeNode hook', () => {
  // A host cleaner (as the TinyMCE plugin would supply): strip the reserved
  // data-mce-* namespace off a *cloned* element, then native outerHTML.
  const stripMce = (/** @type {Element} */ node) => {
    for (const a of Array.from(node.attributes)) {
      if (a.name.startsWith('data-mce-')) node.removeAttribute(a.name)
    }
    return node.outerHTML
  }

  it('strips data-mce-* from open tags, keeps real attributes', () => {
    const rope = buildRope(el('<p class="x" data-mce-foo="y">hi</p>'), stripMce)
    expect(rope?.serialize()).toBe('<p class="x">hi</p>')
  })

  it('strips data-mce-* from nested/void elements', () => {
    const rope = buildRope(el('<p><img src="a.png" data-mce-src="a.png"></p>'), stripMce)
    expect(rope?.serialize()).toBe('<p><img src="a.png"></p>')
  })

  it('keeps a bogus <br> as a plain <br> (attrs stripped, node kept)', () => {
    const rope = buildRope(el('<p><br data-mce-bogus="1"></p>'), stripMce)
    expect(rope?.serialize()).toBe('<p><br></p>')
  })

  it('default (no hook) leaves attributes untouched', () => {
    const rope = buildRope(el('<p data-mce-foo="y">hi</p>'))
    expect(rope?.serialize()).toBe('<p data-mce-foo="y">hi</p>')
  })

  it('cleaned offsets stay self-consistent (getRange matches serialize length)', () => {
    const rope = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (
      buildRope(el('<p class="x" data-mce-foo="y">hi</p>'), stripMce)
    )
    // The <p> open tag is the clean "<p class=\"x\">" (13), not the dirty one.
    const p = /** @type {Element} */ (rope.getAtVisIx(0)?.node.domNode)
    expect(rope.getRange(p)).toEqual([0, rope.serialize().length - 1])
  })
})

// ---------------------------------------------------------------------------
// treap invariants
// ---------------------------------------------------------------------------

describe('treap invariants', () => {
  it('in-order serialization matches serialize()', () => {
    const rope = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (buildRope(el('<b>hello<u> world</u></b>')))
    const text = inOrder(rope.root).map(n => n.text).join('')
    expect(text).toBe(rope.serialize())
  })

  it('weight equals total text length', () => {
    const rope = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (buildRope(el('<div><p>one</p><p>two</p></div>')))
    expect(rope.length).toBe(rope.serialize().length)
  })

  it('every node weight = left.weight + text.length + right.weight', () => {
    const rope = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (buildRope(el('<div><p><em>deep</em></p><span>x</span></div>')))
    for (const node of inOrder(rope.root)) {
      const expected =
        (node.left  ? node.left.weight  : 0) +
        node.text.length +
        (node.right ? node.right.weight : 0)
      expect(node.weight).toBe(expected)
    }
  })

  it('max-heap priority property: parent.priority >= children.priority', () => {
    const rope = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (buildRope(el('<ul><li>a</li><li>b</li><li>c</li><li>d</li></ul>')))
    for (const node of inOrder(rope.root)) {
      if (node.left)  expect(node.priority).toBeGreaterThanOrEqual(node.left.priority)
      if (node.right) expect(node.priority).toBeGreaterThanOrEqual(node.right.priority)
    }
  })

  it('parent pointers are consistent', () => {
    const rope = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (buildRope(el('<div><p>x</p><span>y</span></div>')))
    expect(rope.root?.parent).toBeNull()
    for (const node of inOrder(rope.root)) {
      if (node.left)  expect(node.left.parent).toBe(node)
      if (node.right) expect(node.right.parent).toBe(node)
    }
  })

  it('node kinds are correct', () => {
    const rope = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (buildRope(el('<b>hi</b>')))
    const nodes = inOrder(rope.root)
    expect(nodes[0].kind).toBe('open')   // <b>
    expect(nodes[1].kind).toBe('text')   // hi
    expect(nodes[2].kind).toBe('close')  // </b>
  })

  it('void elements have no close node', () => {
    const rope = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (buildRope(el('<div><br></div>')))
    const nodes = inOrder(rope.root)
    const brRopeNodes = nodes.filter(n => n.domNode instanceof Element &&
      n.domNode.tagName.toLowerCase() === 'br')
    expect(brRopeNodes).toHaveLength(1)
    expect(brRopeNodes[0].kind).toBe('open')
  })
})

// ---------------------------------------------------------------------------
// getAtVisIx
// ---------------------------------------------------------------------------

describe('getAtVisIx', () => {
  // innerHTML: '<b>hello<u> world</u></b>'
  //             01234567890123456789012345
  //                      1111111111222222
  // <b>       [0,2]
  // hello     [3,7]
  // <u>       [8,10]
  //  world    [11,16]
  // </u>      [17,20]
  // </b>      [21,24]

  /** @type {NonNullable<ReturnType<typeof buildRope>>} */
  let rope
  /** @type {HTMLDivElement} */
  let wrapper
  /** @type {Element} */
  let b
  /** @type {Element} */
  let u

  beforeEach(() => {
    wrapper = el('<b>hello<u> world</u></b>')
    b = /** @type {Element} */ (wrapper.firstElementChild)
    u = /** @type {Element} */ (b.querySelector('u'))
    rope = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (buildRope(wrapper))
  })

  it('index 8 is the < of the <u> open tag', () => {
    const r = rope.getAtVisIx(8)
    expect(r?.node.kind).toBe('open')
    expect(r?.node.domNode).toBe(u)
    expect(r?.offset).toBe(0)
    expect(r?.nodeStart).toBe(8)
  })

  it('index 9 is the u of <u>', () => {
    const r = rope.getAtVisIx(9)
    expect(r?.node.domNode).toBe(u)
    expect(r?.node.kind).toBe('open')
    expect(r?.offset).toBe(1)
  })

  it('index 18 is the / in </u>', () => {
    const r = rope.getAtVisIx(18)
    expect(r?.node.kind).toBe('close')
    expect(r?.node.domNode).toBe(u)
    expect(r?.offset).toBe(1)  // '<' is 0, '/' is 1
  })

  it('index 3 is the start of text "hello"', () => {
    const r = rope.getAtVisIx(3)
    expect(r?.node.kind).toBe('text')
    expect(r?.offset).toBe(0)
  })

  it('index 7 is the last char of text "hello"', () => {
    const r = rope.getAtVisIx(7)
    expect(r?.node.kind).toBe('text')
    expect(r?.offset).toBe(4)
  })

  it('index 0 is the < of the root <b> open tag', () => {
    const r = rope.getAtVisIx(0)
    expect(r?.node.domNode).toBe(b)
    expect(r?.node.kind).toBe('open')
    expect(r?.offset).toBe(0)
  })

  it('index 24 is the > of the </b> close tag', () => {
    const r = rope.getAtVisIx(24)
    expect(r?.node.domNode).toBe(b)
    expect(r?.node.kind).toBe('close')
    expect(r?.offset).toBe(3)  // <(0) /(1) b(2) >(3)
  })

  it('returns null for negative index', () => {
    expect(rope.getAtVisIx(-1)).toBeNull()
  })

  it('returns null for index past end', () => {
    expect(rope.getAtVisIx(25)).toBeNull()
  })

  it('void element: index inside <br> open tag', () => {
    const wrapper2 = el('<div>x<br>y</div>')
    // innerHTML: '<div>x<br>y</div>' — <div>=5, x=1 → <br> starts at index 6
    const r = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (buildRope(wrapper2)).getAtVisIx(6)
    expect(r?.node.kind).toBe('open')
    expect(/** @type {Element} */ (r?.node.domNode).tagName.toLowerCase()).toBe('br')
  })
})

// ---------------------------------------------------------------------------
// getRange
// ---------------------------------------------------------------------------

describe('getRange', () => {
  it('user example: <u> returns [8, 20]', () => {
    const wrapper = el('<b>hello<u> world</u></b>')
    const u = /** @type {Element} */ (wrapper.querySelector('u'))
    expect(buildRope(wrapper)?.getRange(u)).toEqual([8, 20])
  })

  it('root element spans the whole string', () => {
    const wrapper = el('<b>hello<u> world</u></b>')
    const b = /** @type {Element} */ (wrapper.firstElementChild)
    const rope = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (buildRope(wrapper))
    expect(rope.getRange(b)).toEqual([0, rope.length - 1])
  })

  it('text node range', () => {
    const wrapper = el('<p>hello</p>')
    const p = /** @type {Element} */ (wrapper.firstElementChild)
    const text = /** @type {Text} */ (p.firstChild)
    // innerHTML: '<p>hello</p>' — <p>=[0,2], hello=[3,7]
    expect(buildRope(wrapper)?.getRange(text)).toEqual([3, 7])
  })

  it('first sibling element', () => {
    const div = el('<div><span>hi</span><em>!</em></div>')
    const span = /** @type {Element} */ (div.querySelector('span'))
    // innerHTML: '<div><span>hi</span><em>!</em></div>'
    // <div>=5, <span>hi</span> starts at 5, length=15, ends at 19
    expect(buildRope(div)?.getRange(span)).toEqual([5, 19])
  })

  it('second sibling element', () => {
    const div = el('<div><span>hi</span><em>!</em></div>')
    const em = /** @type {Element} */ (div.querySelector('em'))
    // <em>!</em> starts at 20, length=10, ends at 29
    expect(buildRope(div)?.getRange(em)).toEqual([20, 29])
  })

  it('returns null for node not in tree', () => {
    const rope = buildRope(el('<p>hi</p>'))
    expect(rope?.getRange(document.createElement('span'))).toBeNull()
  })

  it('void element range (no close tag)', () => {
    const div = el('<div><br></div>')
    const br = /** @type {Element} */ (div.querySelector('br'))
    // <div>=5, <br>=4 → [5, 8]
    expect(buildRope(div)?.getRange(br)).toEqual([5, 8])
  })

  it('deeply nested element range', () => {
    const div = el('<div><p><em>x</em></p></div>')
    const em = /** @type {Element} */ (div.querySelector('em'))
    // <div>=5, <p>=3 → em starts at 8; <em>x</em> = 10 chars → [8, 17]
    expect(buildRope(div)?.getRange(em)).toEqual([8, 17])
  })
})

// ---------------------------------------------------------------------------
// getAtVisIx / getRange round-trip consistency
// ---------------------------------------------------------------------------

describe('consistency', () => {
  it('getAtVisIx at getRange start lands on the open node', () => {
    const div = el('<div><p>text</p><span>more</span></div>')
    const span = /** @type {Element} */ (div.querySelector('span'))
    const rope = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (buildRope(div))
    const [start] = /** @type {[number,number]} */ (rope.getRange(span))
    const r = rope.getAtVisIx(start)
    expect(r?.node.domNode).toBe(span)
    expect(r?.node.kind).toBe('open')
  })

  it('getAtVisIx at getRange end lands on the close node', () => {
    const div = el('<div><p>text</p><span>more</span></div>')
    const span = /** @type {Element} */ (div.querySelector('span'))
    const rope = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (buildRope(div))
    const [, end] = /** @type {[number,number]} */ (rope.getRange(span))
    const r = rope.getAtVisIx(end)
    expect(r?.node.domNode).toBe(span)
    expect(r?.node.kind).toBe('close')
  })

  it('every index in a text node range returns that text node', () => {
    const wrapper = el('<p>hello</p>')
    const p = /** @type {Element} */ (wrapper.firstElementChild)
    const text = /** @type {Text} */ (p.firstChild)
    const rope = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (buildRope(wrapper))
    const [start, end] = /** @type {[number,number]} */ (rope.getRange(text))
    for (let i = start; i <= end; i++) {
      expect(rope.getAtVisIx(i)?.node.domNode).toBe(text)
    }
  })
})

// ---------------------------------------------------------------------------
// rebuild
// ---------------------------------------------------------------------------

describe('rebuild', () => {
  it('updates weight after text content change', () => {
    const div = el('<div><p>hi</p></div>')
    const p = /** @type {Element} */ (div.querySelector('p'))
    const rope = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (buildRope(div))
    // innerHTML: '<div><p>hi</p></div>'
    // <div>=5, <p>=3, hi=2, </p>=4, </div>=6 → 20
    expect(rope.length).toBe(20)

    p.textContent = 'hello world'
    rope.rebuild(p)

    expect(rope.length).toBe(29)
    expect(rope.serialize()).toBe('<div><p>hello world</p></div>')
  })

  it('treap invariants hold after rebuild', () => {
    const div = el('<div><p>old</p></div>')
    const p = /** @type {Element} */ (div.querySelector('p'))
    const rope = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (buildRope(div))

    p.innerHTML = '<em>new</em>'
    rope.rebuild(p)

    for (const node of inOrder(rope.root)) {
      if (node.left)  expect(node.priority).toBeGreaterThanOrEqual(node.left.priority)
      if (node.right) expect(node.priority).toBeGreaterThanOrEqual(node.right.priority)
      const w = (node.left?.weight ?? 0) + node.text.length + (node.right?.weight ?? 0)
      expect(node.weight).toBe(w)
    }
  })

  it('getRange is correct after rebuild shifts a sibling', () => {
    const div = el('<div><span>short</span><em>!</em></div>')
    const span = /** @type {Element} */ (div.querySelector('span'))
    const em = /** @type {Element} */ (div.querySelector('em'))
    const rope = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (buildRope(div))

    span.textContent = 'much longer text'
    rope.rebuild(span)

    const [spanStart, spanEnd] = /** @type {[number,number]} */ (rope.getRange(span))
    const [emStart] = /** @type {[number,number]} */ (rope.getRange(em))
    expect(emStart).toBe(spanEnd + 1)
    expect(spanStart).toBe(5) // <div> = 5
  })

  it('serialize matches innerHTML after rebuild', () => {
    const div = el('<div><p>old</p></div>')
    const p = /** @type {Element} */ (div.querySelector('p'))
    const rope = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (buildRope(div))

    p.innerHTML = '<strong>new</strong>'
    rope.rebuild(p)

    expect(rope.serialize()).toBe(div.innerHTML)
  })

  it('new nodes are in the nodeMap after rebuild', () => {
    const div = el('<div><p>text</p></div>')
    const p = /** @type {Element} */ (div.querySelector('p'))
    const rope = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (buildRope(div))

    p.innerHTML = '<em>emphasis</em>'
    rope.rebuild(p)

    const em = /** @type {Element} */ (p.querySelector('em'))
    expect(rope.getRange(em)).not.toBeNull()
  })

  it('old nodes are removed from nodeMap after rebuild', () => {
    const div = el('<div><p><em>old</em></p></div>')
    const p = /** @type {Element} */ (div.querySelector('p'))
    const oldEm = /** @type {Element} */ (p.querySelector('em'))
    const rope = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (buildRope(div))

    p.innerHTML = 'plain text'
    rope.rebuild(p)

    expect(rope.getRange(oldEm)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// getTagRanges
// ---------------------------------------------------------------------------

describe('getTagRanges', () => {
  // Helper: return just {tag, startIx, endIx} for easier assertions.
  function ranges(/** @type {string} */ html, /** @type {number} */ startIx, /** @type {number} */ endIx) {
    const rope = /** @type {NonNullable<ReturnType<typeof buildRope>>} */ (buildRope(el(html)))
    return rope.getTagRanges(startIx, endIx).map(({ tag, startIx, endIx }) => ({ tag, startIx, endIx }))
  }

  // --- Plain text (no tags to find) ---

  it('returns empty for plain text', () => {
    // innerHTML: 'hello' → indices [0,4]
    expect(ranges('hello', 0, 4)).toEqual([])
  })

  // --- Single tag ---
  // innerHTML: '<b>hello</b>' → <b>=[0,2], hello=[3,7], </b>=[8,11]

  it('finds a tag that fully encloses the selection', () => {
    const r = ranges('<b>hello</b>', 3, 7)
    expect(r).toEqual([{ tag: 'b', startIx: 0, endIx: 11 }])
  })

  it('finds a tag when selection equals the tag range exactly', () => {
    const r = ranges('<b>hello</b>', 0, 11)
    expect(r).toEqual([{ tag: 'b', startIx: 0, endIx: 11 }])
  })

  it('finds a tag when selection is a single char inside it', () => {
    const r = ranges('<b>hello</b>', 5, 5)
    expect(r).toEqual([{ tag: 'b', startIx: 0, endIx: 11 }])
  })

  it('finds a tag when selection overlaps its open tag', () => {
    // selection [0,3] overlaps <b> open tag and first char of text
    const r = ranges('<b>hello</b>', 0, 3)
    expect(r).toEqual([{ tag: 'b', startIx: 0, endIx: 11 }])
  })

  it('finds a tag when selection overlaps its close tag', () => {
    // selection [7,11] overlaps last char of text and </b>
    const r = ranges('<b>hello</b>', 7, 11)
    expect(r).toEqual([{ tag: 'b', startIx: 0, endIx: 11 }])
  })

  // --- Nested tags ---
  // innerHTML: '<b>he<i>ll</i>o</b>'
  // <b>=[0,2], he=[3,4], <i>=[5,7], ll=[8,9], </i>=[10,13], o=[14], </b>=[15,18]

  it('finds both tags when selection is inside nested tags', () => {
    const r = ranges('<b>he<i>ll</i>o</b>', 8, 9)
    expect(r).toContainEqual({ tag: 'b', startIx: 0, endIx: 18 })
    expect(r).toContainEqual({ tag: 'i', startIx: 5, endIx: 13 })
    expect(r).toHaveLength(2)
  })

  it('finds only outer tag when selection spans past inner tag', () => {
    // selection [3,14] covers "he<i>ll</i>o" — fully contains <i>, enclosed by <b>
    const r = ranges('<b>he<i>ll</i>o</b>', 3, 14)
    expect(r).toContainEqual({ tag: 'b', startIx: 0, endIx: 18 })
    expect(r).toContainEqual({ tag: 'i', startIx: 5, endIx: 13 })
    expect(r).toHaveLength(2)
  })

  it('finds outer tag only when selection is outside inner tag', () => {
    // selection [3,4] = "he", inside <b> but before <i>
    const r = ranges('<b>he<i>ll</i>o</b>', 3, 4)
    expect(r).toEqual([{ tag: 'b', startIx: 0, endIx: 18 }])
  })

  // --- Sibling tags ---
  // innerHTML: '<b>one</b><i>two</i>'
  // <b>=[0,2], one=[3,5], </b>=[6,9], <i>=[10,12], two=[13,15], </i>=[16,19]

  it('finds only the first tag when selection is inside it', () => {
    const r = ranges('<b>one</b><i>two</i>', 3, 5)
    expect(r).toEqual([{ tag: 'b', startIx: 0, endIx: 9 }])
  })

  it('finds only the second tag when selection is inside it', () => {
    const r = ranges('<b>one</b><i>two</i>', 13, 15)
    expect(r).toEqual([{ tag: 'i', startIx: 10, endIx: 19 }])
  })

  it('finds both sibling tags when selection spans across them', () => {
    // selection [3,15] spans from "one" through "two"
    const r = ranges('<b>one</b><i>two</i>', 3, 15)
    expect(r).toContainEqual({ tag: 'b', startIx: 0, endIx: 9 })
    expect(r).toContainEqual({ tag: 'i', startIx: 10, endIx: 19 })
    expect(r).toHaveLength(2)
  })

  // --- Partial overlap ---
  // innerHTML: 'aa<b>bb</b>cc'
  // aa=[0,1], <b>=[2,4], bb=[5,6], </b>=[7,10], cc=[11,12]

  it('finds tag with partial left overlap', () => {
    // selection [0,5] starts before <b>, ends inside it
    const r = ranges('aa<b>bb</b>cc', 0, 5)
    expect(r).toEqual([{ tag: 'b', startIx: 2, endIx: 10 }])
  })

  it('finds tag with partial right overlap', () => {
    // selection [5,12] starts inside <b>, extends past it
    const r = ranges('aa<b>bb</b>cc', 5, 12)
    expect(r).toEqual([{ tag: 'b', startIx: 2, endIx: 10 }])
  })

  it('returns empty when selection is entirely outside tags', () => {
    // selection [0,1] = "aa", before the <b>
    const r = ranges('aa<b>bb</b>cc', 0, 1)
    expect(r).toEqual([])
  })

  it('returns empty when selection is after tags', () => {
    // selection [11,12] = "cc", after </b>
    const r = ranges('aa<b>bb</b>cc', 11, 12)
    expect(r).toEqual([])
  })

  // --- Deeply nested ---
  // innerHTML: '<div><p><em>deep</em></p></div>'
  // <div>=[0,4], <p>=[5,7], <em>=[8,11], deep=[12,15], </em>=[16,20], </p>=[21,24], </div>=[25,30]

  it('finds all ancestor tags for deeply nested selection', () => {
    const r = ranges('<div><p><em>deep</em></p></div>', 12, 15)
    expect(r).toContainEqual({ tag: 'div', startIx: 0, endIx: 30 })
    expect(r).toContainEqual({ tag: 'p', startIx: 5, endIx: 24 })
    expect(r).toContainEqual({ tag: 'em', startIx: 8, endIx: 20 })
    expect(r).toHaveLength(3)
  })

  // --- Void elements ---
  // innerHTML: 'a<br>b'
  // a=[0], <br>=[1,4], b=[5]

  it('finds void element when selection overlaps it', () => {
    const r = ranges('a<br>b', 0, 5)
    expect(r).toEqual([{ tag: 'br', startIx: 1, endIx: 4 }])
  })

  it('does not find void element when selection is after it', () => {
    const r = ranges('a<br>b', 5, 5)
    expect(r).toEqual([])
  })

  // --- Multiple nested and sibling ---
  // innerHTML: '<b>a<i>b</i></b><u>c</u>'
  // <b>=[0,2], a=[3], <i>=[4,6], b=[7], </i>=[8,11], </b>=[12,15], <u>=[16,18], c=[19], </u>=[20,23]

  it('finds overlapping tags in complex structure', () => {
    // selection [3,19] spans from "a" in <b> to "c" in <u>
    const r = ranges('<b>a<i>b</i></b><u>c</u>', 3, 19)
    expect(r).toContainEqual({ tag: 'b', startIx: 0, endIx: 15 })
    expect(r).toContainEqual({ tag: 'i', startIx: 4, endIx: 11 })
    expect(r).toContainEqual({ tag: 'u', startIx: 16, endIx: 23 })
    expect(r).toHaveLength(3)
  })

  // --- No duplicates ---

  it('does not return duplicate entries for the same element', () => {
    // selection covers entire <b> tag including open and close nodes
    const r = ranges('<b>hello</b>', 0, 11)
    const bTags = r.filter(t => t.tag === 'b')
    expect(bTags).toHaveLength(1)
  })

  // --- Edge: selection is exactly one tag boundary ---

  it('finds tag when selection starts at close tag', () => {
    // selection [8,11] = exactly the </b> close tag
    const r = ranges('<b>hello</b>', 8, 11)
    expect(r).toEqual([{ tag: 'b', startIx: 0, endIx: 11 }])
  })

  it('finds tag when selection starts at open tag', () => {
    // selection [0,2] = exactly the <b> open tag
    const r = ranges('<b>hello</b>', 0, 2)
    expect(r).toEqual([{ tag: 'b', startIx: 0, endIx: 11 }])
  })
})
