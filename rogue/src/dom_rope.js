// @ts-check

/**
 * @typedef {'open' | 'text' | 'close'} RopeNodeKind
 *
 * @typedef {{
 *   text: string,
 *   weight: number,
 *   priority: number,
 *   left: RopeNode | null,
 *   right: RopeNode | null,
 *   parent: RopeNode | null,
 *   domNode: Element | Text,
 *   kind: RopeNodeKind,
 * }} RopeNode
 *
 * @typedef {{ node: RopeNode, nodeStart: number, offset: number }} AtIndexResult
 */

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/**
 * Ordered [raw, escaped] pairs — the single source of truth for `escapeText`
 * (forward) and its inverse `escapeTextOffset`. The first entry strips the U+FEFF
 * caret placeholder (escape-to-empty); the rest are the fixed HTML entity escapes,
 * exactly the set the WHATWG fragment-serialization spec applies to text nodes, so
 * the browser's own `.outerHTML` serialization of the same text agrees. `&` must
 * precede `<`/`>` so the `&` introduced by `&lt;`/`&gt;` isn't re-escaped. Keys are
 * literal chars (not regex metacharacters) and replacements contain no `$`, so both
 * are safe as-is in `new RegExp(raw, 'g')` and `String.replace(re, escaped)`.
 */
const ENTITIES = [
  ['\uFEFF', ''],
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['\u00A0', '&nbsp;'],
]

/** Escaped length per raw char, derived from ENTITIES (unknown chars → 1). */
const ESCAPED_LENGTH = new Map(ENTITIES.map(([raw, escaped]) => [raw, escaped.length]))

/** Precompiled [regex, replacement] pairs derived from ENTITIES. @type {[RegExp, string][]} */
const REPLACERS = ENTITIES.map(([raw, escaped]) => [new RegExp(raw, 'g'), escaped])

/** @internal @param {string} text @returns {string} */
export function escapeText(text) {
  let out = text
  for (const [re, escaped] of REPLACERS) out = out.replace(re, escaped)
  return out
}

/** @internal @param {Element} el @returns {string} */
export function getCloseTag(el) {
  if (VOID_ELEMENTS.has(el.tagName.toLowerCase())) return ''
  return `</${el.tagName.toLowerCase()}>`
}

/**
 * Serialize a *cloned, mutable* element to its clean outerHTML string. The
 * default is native `.outerHTML` (no cleaning); a host (e.g. the TinyMCE plugin)
 * overrides it to strip its internal attributes. Callers always pass a clone, so
 * the hook may mutate it. It must keep native-outerHTML formatting (not run a
 * full HTML serializer) so getOpenTag's close-tag slice stays valid.
 * @typedef {(node: Element) => string} SerializeNode
 */

/**
 * Predicate for DOM nodes to omit from the rope entirely — host editing chrome
 * that isn't document content (e.g. TinyMCE's resize handles / bogus nodes). Must
 * be applied identically wherever the DOM is serialized (the rope build here and
 * sync's rangeOuterHtml) or the two representations disagree.
 * @typedef {(node: Node) => boolean} OmitNode
 */

/** @internal @type {SerializeNode} */
export const defaultSerializeNode = (node) => node.outerHTML

/** @internal @type {OmitNode} */
export const defaultOmitNode = () => false

/**
 * Predicate for DOM wrappers to traverse *transparently*: their children are kept
 * in the rope but the wrapper itself emits no open/close tags (e.g. TinyMCE's
 * format-caret bookmarks, which wrap real content in a `<span data-mce-type="format-caret">`).
 * @typedef {(node: Node) => boolean} UnwrapNode
 */

/** @internal @type {UnwrapNode} */
export const defaultUnwrapNode = () => false

/**
 * Predicate for DOM elements to treat as *opaque*: keep the element's own tags
 * and attributes (serialized through `serializeNode`), but drop every child from
 * the rope. The CRDT then stores an empty shell — `<div data-cell="…"></div>` —
 * while the host keeps whatever it renders inside.
 *
 * The fourth quadrant of the node hooks:
 *
 * | hook | own tags | children |
 * |---|---|---|
 * | `omitNode` | drop | drop |
 * | `unwrapNode` | drop | keep |
 * | `opaqueNode` | **keep** | **drop** |
 * | default | keep | keep |
 *
 * Precedence is `omitNode` → `unwrapNode` → `opaqueNode`. A node matching more
 * than one is a host bug; the first match wins.
 *
 * Hosts own the dropped subtree: it must be re-mounted after every render, the
 * element should be `contenteditable="false"` so selection can't descend into
 * content the rope doesn't index, and its state is not covered by undo/snapshots.
 * @typedef {(node: Node) => boolean} OpaqueNode
 */

/** @internal @type {OpaqueNode} */
export const defaultOpaqueNode = () => false

/** @internal @param {Element} el @param {SerializeNode} [serializeNode] @returns {string} */
export function getOpenTag(el, serializeNode = defaultSerializeNode) {
  const closeTag = getCloseTag(el)
  const shell = serializeNode(/** @type {Element} */ (el.cloneNode(false)))
  return shell.slice(0, shell.length - closeTag.length)
}

// ---------------------------------------------------------------------------
// Treap node primitives
// ---------------------------------------------------------------------------

/**
 * @param {string} text
 * @param {Element | Text} domNode
 * @param {RopeNodeKind} kind
 * @returns {RopeNode}
 */
function makeNode(text, domNode, kind) {
  return {
    text,
    weight: text.length,
    priority: Math.random(),
    left: null,
    right: null,
    parent: null,
    domNode,
    kind,
  }
}

/** @param {RopeNode} node */
function updateWeight(node) {
  node.weight =
    (node.left  ? node.left.weight  : 0) +
    node.text.length +
    (node.right ? node.right.weight : 0)
}

// ---------------------------------------------------------------------------
// Treap operations
// ---------------------------------------------------------------------------

/**
 * Build a max-heap treap (by priority) from an ordered rope-node array in O(n)
 * using the stack-based Cartesian tree algorithm.
 * In-order traversal of the result equals the input array order.
 * @param {RopeNode[]} nodes
 * @returns {RopeNode | null}
 */
function buildTreap(nodes) {
  if (nodes.length === 0) return null

  /** @type {RopeNode[]} */
  const stack = []

  for (const node of nodes) {
    node.left = node.right = node.parent = null
    let last = /** @type {RopeNode | null} */ (null)

    while (stack.length > 0 && stack[stack.length - 1].priority < node.priority) {
      last = /** @type {RopeNode} */ (stack.pop())
    }

    node.left = last
    if (last) last.parent = node

    if (stack.length > 0) {
      const top = stack[stack.length - 1]
      top.right = node
      node.parent = top
    }

    stack.push(node)
  }

  const root = stack[0]
  root.parent = null
  updateWeightsPostOrder(root)
  return root
}

/** @param {RopeNode | null} node */
function updateWeightsPostOrder(node) {
  if (!node) return
  updateWeightsPostOrder(node.left)
  updateWeightsPostOrder(node.right)
  updateWeight(node)
}

/**
 * Merge two treaps. Every key in `left` precedes every key in `right`.
 * @param {RopeNode | null} left
 * @param {RopeNode | null} right
 * @returns {RopeNode | null}
 */
function merge(left, right) {
  if (!left) return right
  if (!right) return left

  if (left.priority >= right.priority) {
    left.right = merge(left.right, right)
    if (left.right) left.right.parent = left
    updateWeight(left)
    left.parent = null
    return left
  } else {
    right.left = merge(left, right.left)
    if (right.left) right.left.parent = right
    updateWeight(right)
    right.parent = null
    return right
  }
}

/**
 * Split into [chars 0..index-1] and [chars index..end].
 * If the split point falls inside a node's text the text is split into two
 * nodes (each inheriting the original's priority to preserve heap order).
 * @param {RopeNode | null} node
 * @param {number} index  number of characters to put in the left treap
 * @returns {[RopeNode | null, RopeNode | null]}
 */
function split(node, index) {
  if (!node) return [null, null]

  const leftW = node.left ? node.left.weight : 0

  if (index <= leftW) {
    const [l, r] = split(node.left, index)
    node.left = r
    if (r) r.parent = node
    updateWeight(node)
    node.parent = null
    return [l, node]
  }

  if (index < leftW + node.text.length) {
    // A cut *inside* a token's text would divide it into two rope nodes sharing
    // one domNode — the next purgeMap would then delete that domNode from nodeMap
    // while a half-token still lives in the tree, desyncing getRange/cursor
    // lookups. Rope mutations only ever cut on token boundaries (the range is
    // sibling-aligned by siblingRegion), so landing here is an invariant
    // violation: fail loudly rather than silently corrupt.
    throw new Error(
      `rope split at mid-token index ${index} (token starts at ${leftW}, ` +
        `length ${node.text.length}) — mutations must cut on token boundaries`,
    )
  }

  const [l, r] = split(node.right, index - leftW - node.text.length)
  node.right = l
  if (l) l.parent = node
  updateWeight(node)
  node.parent = null
  return [node, r]
}

// ---------------------------------------------------------------------------
// DOM walking
// ---------------------------------------------------------------------------

/**
 * Walk a DOM subtree in document order, appending rope nodes to `out` and
 * registering them in `nodeMap`.
 *   text node  → one rope node (kind 'text')
 *   element    → open node (kind 'open') + children + close node (kind 'close')
 *   void elem  → one rope node (kind 'open', no close)
 * @param {Node} node
 * @param {RopeNode[]} out
 * @param {WeakMap<Node, RopeNode[]>} nodeMap
 * @param {SerializeNode} serializeNode
 * @param {OmitNode} [omitNode]
 * @param {UnwrapNode} [unwrapNode]
 * @param {OpaqueNode} [opaqueNode]
 */
function toRopeNodes(node, out, nodeMap, serializeNode, omitNode = defaultOmitNode, unwrapNode = defaultUnwrapNode, opaqueNode = defaultOpaqueNode) {
  if (omitNode(node)) return

  if (node.nodeType === 3 /* TEXT_NODE */) {
    const t = /** @type {Text} */ (node)
    const rn = makeNode(escapeText(t.data), t, 'text')
    nodeMap.set(t, [rn])
    out.push(rn)
    return
  }

  if (node.nodeType !== 1 /* ELEMENT_NODE */) return
  const el = /** @type {Element} */ (node)

  if (unwrapNode(el)) {
    // Transparent wrapper: keep children, emit no tags for the wrapper itself.
    for (const child of el.childNodes) toRopeNodes(child, out, nodeMap, serializeNode, omitNode, unwrapNode, opaqueNode)
    return
  }

  const open = makeNode(getOpenTag(el, serializeNode), el, 'open')
  out.push(open)

  // Opaque: keep the shell, drop the subtree. A void element has no children to
  // drop, so this is a no-op for it.
  if (!opaqueNode(el)) {
    for (const child of el.childNodes) toRopeNodes(child, out, nodeMap, serializeNode, omitNode, unwrapNode, opaqueNode)
  }

  const ct = getCloseTag(el)
  if (ct) {
    const close = makeNode(ct, el, 'close')
    out.push(close)
    nodeMap.set(el, [open, close])
  } else {
    nodeMap.set(el, [open])   // void element
  }
}

/**
 * Remove all nodes in a treap subtree from the nodeMap.
 * @param {RopeNode | null} node
 * @param {WeakMap<Node, RopeNode[]>} nodeMap
 */
function purgeMap(node, nodeMap) {
  if (!node) return
  purgeMap(node.left,  nodeMap)
  purgeMap(node.right, nodeMap)
  nodeMap.delete(node.domNode)
}

// ---------------------------------------------------------------------------
// Index / position helpers
// ---------------------------------------------------------------------------

/**
 * Walk parent pointers to compute the absolute start index of a rope node.
 * O(log n) expected for a balanced treap.
 * @param {RopeNode} node
 * @returns {number}
 */
function computeStart(node) {
  let start = node.left ? node.left.weight : 0
  let cur = node
  while (cur.parent) {
    if (cur.parent.right === cur) {
      start += (cur.parent.left ? cur.parent.left.weight : 0) + cur.parent.text.length
    }
    cur = cur.parent
  }
  return start
}

/**
 * @param {RopeNode | null} node
 * @param {number} index
 * @param {number} absOffset  accumulated absolute offset of the left edge of `node`
 * @returns {AtIndexResult | null}
 */
function getAtIndexInternal(node, index, absOffset) {
  if (!node) return null

  const leftW = node.left ? node.left.weight : 0

  if (index < leftW) {
    return getAtIndexInternal(node.left, index, absOffset)
  }

  if (index < leftW + node.text.length) {
    return { node, nodeStart: absOffset + leftW, offset: index - leftW }
  }

  return getAtIndexInternal(
    node.right,
    index - leftW - node.text.length,
    absOffset + leftW + node.text.length,
  )
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * @param {RopeNode | null} node
 * @returns {string}
 */
function serializeSubtree(node) {
  if (!node) return ''
  return serializeSubtree(node.left) + node.text + serializeSubtree(node.right)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inverse of `escapeText` for offsets: map a position within a text node's
 * *escaped* content back to the raw character offset. Walks the raw text
 * accumulating each character's escaped length from the shared ENTITIES table,
 * so it can't drift from `escapeText`.
 * @internal
 * @param {string} rawText
 * @param {number} htmlOffset
 * @returns {number}
 */
function escapeTextOffset(rawText, htmlOffset) {
  let h = 0
  let r = 0
  for (; r < rawText.length && h < htmlOffset; r++) {
    h += ESCAPED_LENGTH.get(rawText[r]) ?? 1
  }
  return r
}

export class DomRope {
  /**
   * @param {RopeNode | null} root  null ⇒ an empty rope (empty document)
   * @param {WeakMap<Node, RopeNode[]>} nodeMap
   * @param {Element} container  the element the rope was built from; its children
   *   are the tracked top-level nodes. It is *not* itself tokenized, so it's the
   *   one untracked node update accepts as a parent (a resync edge).
   * @param {SerializeNode} [serializeNode]
   * @param {OmitNode} [omitNode]
   * @param {UnwrapNode} [unwrapNode]
   * @param {OpaqueNode} [opaqueNode]
   */
  constructor(root, nodeMap, container, serializeNode = defaultSerializeNode, omitNode = defaultOmitNode, unwrapNode = defaultUnwrapNode, opaqueNode = defaultOpaqueNode) {
    this.root = root
    this._nodeMap = nodeMap
    this._container = container
    this._serializeNode = serializeNode
    this._omitNode = omitNode
    this._unwrapNode = unwrapNode
    this._opaqueNode = opaqueNode
  }

  /**
   * Is `node` an opaque element, or does it live inside one? Opaque subtrees are
   * not in the rope at all (only the shell is), so a mutation down there is none
   * of the rope's business: splicing it would throw (the parent isn't tracked)
   * and, worse, would pull the host's local children into the CRDT.
   * @param {Node | null} node
   * @returns {boolean}
   */
  _inOpaqueSubtree(node) {
    for (let n = node; n && n !== this._container; n = n.parentNode) {
      if (n.nodeType === 1 /* ELEMENT_NODE */ && this._opaqueNode(/** @type {Element} */ (n))) return true
    }
    return false
  }

  /** @returns {string} */
  serialize() {
    return serializeSubtree(this.root)
  }

  /**
   * Total HTML character length of the rope (== element.innerHTML length).
   * O(1): each node's `weight` is its full subtree aggregate, so the root's
   * weight is the whole-rope length — the same value getAtVisIx bounds against.
   */
  get length() {
    return this.root ? this.root.weight : 0
  }

  /**
   * Find the rope node whose text contains the given HTML char index (visIx),
   * along with the absolute start of that node and the offset within its text.
   * O(log n) expected.
   * @param {number} visIx
   * @returns {AtIndexResult | null}
   */
  getAtVisIx(visIx) {
    if (!this.root || visIx < 0 || visIx >= this.root.weight) return null
    return getAtIndexInternal(this.root, visIx, 0)
  }

  /**
   * Return the [start, end] inclusive HTML character range occupied by a DOM
   * node — from the first char of its open tag to the last char of its close
   * tag (or its text content for text nodes).
   * O(log n) expected via parent-pointer walk; no full-tree traversal.
   * @param {Node} domNode
   * @returns {[number, number] | null}
   */
  getRange(domNode) {
    const ropeNodes = this._nodeMap.get(domNode)
    if (!ropeNodes) return null
    const start = computeStart(ropeNodes[0])
    const last  = ropeNodes[ropeNodes.length - 1]
    const end   = computeStart(last) + last.text.length - 1
    return [start, end]
  }

  /**
   * Convert a DOM selection endpoint (node + offset) to an HTML char offset
   * into the rope's source HTML (element.innerHTML).
   * Returns null if the node is not tracked by this rope.
   * @param {Node} node
   * @param {number} offset
   * @returns {number | null}
   */
  domPosToVisIx(node, offset) {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      const t = /** @type {Text} */ (node)
      const range = this.getRange(t)
      if (!range) return null
      return range[0] + escapeText(t.data.slice(0, offset)).length
    }
    // Element node: offset is a child index.
    const el = /** @type {Element} */ (node)
    if (offset === 0) {
      const range = this.getRange(el)
      if (!range) {
        // el is not in the rope (e.g. the editor element itself) — offset 0
        // means "before all content" which is HTML offset 0.
        return 0
      }
      return range[0] + getOpenTag(el).length
    }
    const prev = el.childNodes[offset - 1]
    const range = this.getRange(prev)
    if (!range) return null
    return range[1] + 1
  }

  /**
   * Convert an HTML char index (vis_ix) to a DOM position suitable for
   * use with Selection.setBaseAndExtent.
   *
   * - kind 'text'  → { node: Text, offset: raw char offset }
   * - kind 'open'  → { node: parentElement, offset: childIndex } (before the element)
   * - kind 'close' → { node: element, offset: childNodes.length } (after all children)
   *
   * The 'open' rule keeps domPosToVisIx / visIxToDomPos round-trippable:
   * placing the cursor inside a void element (e.g. <br>) at offset 0 would map
   * back to after the tag, not before it.
   * @param {number} visIx
   * @returns {{ node: Node, offset: number } | null}
   */
  visIxToDomPos(visIx) {
    const result = this.getAtVisIx(visIx)
    if (!result) return null
    const { node, offset } = result
    if (node.kind === 'text') {
      const t = /** @type {Text} */ (node.domNode)
      return { node: t, offset: escapeTextOffset(t.data, offset) }
    }
    const el = /** @type {Element} */ (node.domNode)
    if (node.kind === 'open') {
      const parent = el.parentNode
      if (!parent) return null
      return { node: parent, offset: Array.from(parent.childNodes).indexOf(el) }
    }
    // kind 'close'
    return { node: el, offset: el.childNodes.length }
  }

  /**
   * Return all element tags that overlap with [startIx, endIx].
   * Walks the rope from startIx rightward, stopping once past endIx.
   * @param {number} startIx
   * @param {number} endIx
   * @returns {{ tag: string, startIx: number, endIx: number, element: Element }[]}
   */
  getTagRanges(startIx, endIx) {
    /** @type {{ tag: string, startIx: number, endIx: number, element: Element }[]} */
    const results = []
    /** @type {Set<Element>} */
    const seen = new Set()

    let ix = startIx
    while (ix <= endIx) {
      const hit = this.getAtVisIx(ix)
      if (!hit) break

      if (hit.node.kind !== 'text') {
        const el = /** @type {Element} */ (hit.node.domNode)
        if (!seen.has(el)) {
          seen.add(el)
          const range = this.getRange(el)
          if (range) {
            results.push({ tag: el.tagName.toLowerCase(), startIx: range[0], endIx: range[1], element: el })
          }
        }
      }

      // Also check ancestors — selection might be inside a <b> without
      // landing directly on the <b>'s open/close node.
      let parent = hit.node.domNode.parentElement
      while (parent) {
        if (!seen.has(parent)) {
          seen.add(parent)
          const range = this.getRange(parent)
          if (range && range[0] <= endIx && range[1] >= startIx) {
            results.push({ tag: parent.tagName.toLowerCase(), startIx: range[0], endIx: range[1], element: parent })
          }
        }
        parent = parent.parentElement
      }

      // Jump past this rope node to the next one.
      ix = hit.nodeStart + hit.node.text.length
    }

    return results
  }

  /**
   * Re-derive the rope for the DOM region bracketed by two surviving anchors,
   * after the nodes inside that region changed — a local in-place edit, a remote
   * subtree swap, or a full rebuild. This is the rope's single scoped-mutation
   * primitive. O(log n + k) where k = the new rope-node count.
   *
   * `beforeNode`/`afterNode` are DOM nodes that *survived* the change and are
   * still tracked, sitting immediately to the left/right of the region; a null
   * anchor means the region runs to the start/end of `parent`'s content. `parent`
   * is the changed nodes' common parent — used to resolve a null anchor and to
   * walk the live children now occupying the region.
   *
   * The cut window comes from the anchors' own (unchanged) token positions: just
   * after `beforeNode`, just before `afterNode`. A null anchor resolves to
   * `parent`'s content edge when `parent` is a tracked block, or to the rope's
   * absolute edge (0 / length) when `parent` isn't tracked — i.e. it's the root
   * container the rope was built from. The region must be sibling-aligned so the
   * split lands on token boundaries and purgeMap stays consistent;
   * `siblingRegion` upstream guarantees that.
   *
   * @param {Node | null} beforeNode
   * @param {Node | null} afterNode
   * @param {Node} parent
   */
  update(beforeNode, afterNode, parent) {
    // A mutation inside an opaque element changes nothing the rope tracks (the
    // subtree was never tokenized). Return before the "parent is not in the rope"
    // assertion below, which would otherwise fire.
    if (this._inOpaqueSubtree(parent)) return

    const parentToks = this._nodeMap.get(parent) // undefined ⇒ parent must be the container
    const beforeToks = beforeNode ? this._nodeMap.get(beforeNode) : null
    const afterToks  = afterNode  ? this._nodeMap.get(afterNode)  : null
    // The region must be tracked: `parent` is a tracked block or the container the
    // rope was built from, and each anchor is null (an edge) or a tracked survivor.
    // Anything else means the caller passed a node that isn't in the rope — the
    // splice would land on a bogus position, so fail loudly rather than corrupt.
    if (!parentToks && parent !== this._container) throw new Error('update: parent is not in the rope')
    if (beforeNode && !beforeToks) throw new Error('update: beforeNode is not in the rope')
    if (afterNode && !afterToks) throw new Error('update: afterNode is not in the rope')

    // Cut window [a, b) in the old rope.
    let a
    if (beforeToks) {
      const t = beforeToks[beforeToks.length - 1]
      a = computeStart(t) + t.text.length // just after the left anchor
    } else if (parentToks) {
      a = computeStart(parentToks[0]) + parentToks[0].text.length // just after <parent …>
    } else {
      a = 0 // root container's start
    }
    let b
    if (afterToks) {
      b = computeStart(afterToks[0]) // just before the right anchor
    } else if (parentToks) {
      b = computeStart(parentToks[parentToks.length - 1]) // just before </parent>
    } else {
      b = this.root ? this.root.weight : 0 // root container's end
    }

    // Live nodes now filling the window: (beforeNode.next … afterNode.prev), or
    // parent's first/last child at a null edge. If the region collapsed to nothing
    // (the anchors are adjacent, or the parent is empty) it's a pure deletion.
    const first = beforeNode ? beforeNode.nextSibling : parent.firstChild
    const empty = !first || first === afterNode

    const [before, rest] = split(this.root, a)
    const [old, after]   = split(rest, b - a)
    purgeMap(old, this._nodeMap)

    /** @type {RopeNode[]} */
    const fresh = []
    if (!empty) {
      const last = afterNode ? afterNode.previousSibling : parent.lastChild
      for (let cur = /** @type {Node | null} */ (first); cur; cur = cur.nextSibling) {
        toRopeNodes(cur, fresh, this._nodeMap, this._serializeNode, this._omitNode, this._unwrapNode, this._opaqueNode)
        if (cur === last) break
      }
    }

    this.root = merge(before, merge(buildTreap(fresh), after))
  }

  /**
   * Test-only convenience: re-derive an in-place node from its live DOM siblings.
   * Production never calls this — the sync layer resolves tracked anchors itself.
   * @param {Node} startNode
   * @param {Node} [endNode]
   */
  rebuild(startNode, endNode = startNode) {
    this.update(
      startNode.previousSibling,
      endNode.nextSibling,
      /** @type {Node} */ (startNode.parentNode),
    )
  }

}

/**
 * Build a DomRope from the children of a DOM Element (not the element itself).
 * HTML offsets produced by this rope match element.innerHTML. Always returns a
 * DomRope — an element with no children yields an empty rope (root null), never
 * null, so callers never have to null-check the instance.
 * @param {Element} element
 * @param {SerializeNode} [serializeNode]
 * @param {OmitNode} [omitNode]
 * @param {UnwrapNode} [unwrapNode]
 * @param {OpaqueNode} [opaqueNode]
 * @returns {DomRope}
 */
export function buildRope(element, serializeNode = defaultSerializeNode, omitNode = defaultOmitNode, unwrapNode = defaultUnwrapNode, opaqueNode = defaultOpaqueNode) {
  /** @type {WeakMap<Node, RopeNode[]>} */
  const nodeMap = new WeakMap()
  /** @type {RopeNode[]} */
  const ropeNodes = []
  for (const child of element.childNodes) {
    toRopeNodes(child, ropeNodes, nodeMap, serializeNode, omitNode, unwrapNode, opaqueNode)
  }
  return new DomRope(buildTreap(ropeNodes), nodeMap, element, serializeNode, omitNode, unwrapNode, opaqueNode)
}
