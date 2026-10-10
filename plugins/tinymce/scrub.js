// @ts-check
//
// TinyMCE DOM-scrubbing hooks — the boundary between "real content" and
// TinyMCE's editor chrome. Mirrors TinyMCE's own serializer (html/Serializer's
// node + attribute filters) so the CRDT only ever stores what getContent()
// would emit. Applied identically by the rope build and the diff's DOM
// serializer (see sync.js's createRogueNode).

/**
 * Omit a node and its subtree entirely: whole chrome containers (resize handles,
 * resizer bars, `data-mce-bogus="all"`). Everything else is content.
 * @param {Node} node
 * @returns {boolean}
 */
export function omitNode(node) {
  if (node.nodeType !== 1) return false
  return /** @type {Element} */ (node).getAttribute('data-mce-bogus') === 'all'
}

/**
 * A transparent wrapper: traverse its children but emit no open/close tags for
 * the wrapper itself — TinyMCE's format-caret bookmark wraps real content in a
 * `<span data-mce-type="format-caret">`.
 * @param {Node} node
 * @returns {boolean}
 */
export function unwrapNode(node) {
  return (
    node.nodeType === 1 &&
    /** @type {Element} */ (node).getAttribute('data-mce-type') === 'format-caret'
  )
}

/**
 * Serialize a *cloned, mutable* element to clean HTML: unwrap format-carets,
 * drop whole chrome nodes, strip `data-mce-*` attributes, and remove the U+FEFF
 * caret placeholder. The clone is mutated in place.
 *
 * Note: we deliberately do NOT strip TinyMCE's bogus `<br>` (`<br
 * data-mce-bogus="1">`) that pads an empty block. Stripping the attribute only
 * leaves a plain `<br>`, which keeps the block non-empty and *visible* in the
 * editor (a real line) rather than collapsing it to an invisible `<p></p>`.
 * @param {Node} node
 * @returns {string}
 */
export function serializeNode(node) {
  if (node.nodeType !== 1) return /** @type {Text} */ (node).data
  const el = /** @type {Element} */ (node)
  // Unwrap nested format-carets *before* stripping their marker attribute.
  for (const caret of Array.from(el.querySelectorAll('[data-mce-type="format-caret"]'))) {
    const parent = caret.parentNode
    if (!parent) continue
    while (caret.firstChild) parent.insertBefore(caret.firstChild, caret)
    caret.remove()
  }
  for (const bogus of Array.from(el.querySelectorAll('[data-mce-bogus="all"]'))) bogus.remove()
  // Strip data-mce-* attributes (this is what turns the bogus <br> into a plain <br>).
  const strip = (/** @type {Element} */ e) => {
    for (const name of e.getAttributeNames()) {
      if (name.startsWith('data-mce-')) e.removeAttribute(name)
    }
  }
  strip(el)
  for (const desc of el.querySelectorAll('*')) strip(desc)
  // Remove the U+FEFF caret placeholder from text.
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let t = walker.nextNode()
  while (t) {
    const text = /** @type {Text} */ (t)
    if (text.data.includes('\uFEFF')) text.data = text.data.replace(/\uFEFF/g, '')
    t = walker.nextNode()
  }
  return el.outerHTML
}
