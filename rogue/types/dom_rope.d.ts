/** @internal @param {string} text @returns {string} */
export function escapeText(text: string): string;
/** @internal @param {Element} el @returns {string} */
export function getCloseTag(el: Element): string;
/** @internal @param {Element} el @param {SerializeNode} [serializeNode] @returns {string} */
export function getOpenTag(el: Element, serializeNode?: SerializeNode): string;
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
export function buildRope(element: Element, serializeNode?: SerializeNode, omitNode?: OmitNode, unwrapNode?: UnwrapNode, opaqueNode?: OpaqueNode): DomRope;
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
export const defaultSerializeNode: SerializeNode;
/** @internal @type {OmitNode} */
export const defaultOmitNode: OmitNode;
/**
 * Predicate for DOM wrappers to traverse *transparently*: their children are kept
 * in the rope but the wrapper itself emits no open/close tags (e.g. TinyMCE's
 * format-caret bookmarks, which wrap real content in a `<span data-mce-type="format-caret">`).
 * @typedef {(node: Node) => boolean} UnwrapNode
 */
/** @internal @type {UnwrapNode} */
export const defaultUnwrapNode: UnwrapNode;
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
 *
 * Cursor restore resolves an index at the shell's end to the shell's close-tag
 * position, i.e. *inside* the element when it holds local children. With
 * `contenteditable="false"` the browser clamps the caret to the shell's edge, so
 * this only bites a host that leaves the shell editable: keystrokes there are
 * outside the index and are dropped by the opaque filter on the next render.
 *
 * Combining this with a *deep*-cleaning `serializeNode` changes what that hook
 * sees: the non-opaque path hands it one deep clone per region, while opaque
 * subtrees are serialized element-by-element (shallow clones). A host that scrubs
 * nested descendants in `serializeNode` must express the same policy through
 * `omitNode`/`unwrapNode`, which are applied at every level either way.
 * @typedef {(node: Node) => boolean} OpaqueNode
 */
/** @internal @type {OpaqueNode} */
export const defaultOpaqueNode: OpaqueNode;
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
    constructor(root: RopeNode | null, nodeMap: WeakMap<Node, RopeNode[]>, container: Element, serializeNode?: SerializeNode, omitNode?: OmitNode, unwrapNode?: UnwrapNode, opaqueNode?: OpaqueNode);
    root: RopeNode | null;
    _nodeMap: WeakMap<Node, RopeNode[]>;
    _container: Element;
    _serializeNode: SerializeNode;
    _omitNode: OmitNode;
    _unwrapNode: UnwrapNode;
    _opaqueNode: OpaqueNode;
    /**
     * Is `node` an opaque element, or does it live inside one? Opaque subtrees are
     * not in the rope at all (only the shell is), so a mutation down there is none
     * of the rope's business: splicing it would throw (the parent isn't tracked)
     * and, worse, would pull the host's local children into the CRDT.
     * @param {Node | null} node
     * @returns {boolean}
     */
    _inOpaqueSubtree(node: Node | null): boolean;
    /** @returns {string} */
    serialize(): string;
    /**
     * Total HTML character length of the rope (== element.innerHTML length).
     * O(1): each node's `weight` is its full subtree aggregate, so the root's
     * weight is the whole-rope length — the same value getAtVisIx bounds against.
     */
    get length(): number;
    /**
     * Find the rope node whose text contains the given HTML char index (visIx),
     * along with the absolute start of that node and the offset within its text.
     * O(log n) expected.
     * @param {number} visIx
     * @returns {AtIndexResult | null}
     */
    getAtVisIx(visIx: number): AtIndexResult | null;
    /**
     * Return the [start, end] inclusive HTML character range occupied by a DOM
     * node — from the first char of its open tag to the last char of its close
     * tag (or its text content for text nodes).
     * O(log n) expected via parent-pointer walk; no full-tree traversal.
     * @param {Node} domNode
     * @returns {[number, number] | null}
     */
    getRange(domNode: Node): [number, number] | null;
    /**
     * Convert a DOM selection endpoint (node + offset) to an HTML char offset
     * into the rope's source HTML (element.innerHTML).
     * Returns null if the node is not tracked by this rope.
     * @param {Node} node
     * @param {number} offset
     * @returns {number | null}
     */
    domPosToVisIx(node: Node, offset: number): number | null;
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
    visIxToDomPos(visIx: number): {
        node: Node;
        offset: number;
    } | null;
    /**
     * Return all element tags that overlap with [startIx, endIx].
     * Walks the rope from startIx rightward, stopping once past endIx.
     * @param {number} startIx
     * @param {number} endIx
     * @returns {{ tag: string, startIx: number, endIx: number, element: Element }[]}
     */
    getTagRanges(startIx: number, endIx: number): {
        tag: string;
        startIx: number;
        endIx: number;
        element: Element;
    }[];
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
    update(beforeNode: Node | null, afterNode: Node | null, parent: Node): void;
    /**
     * Test-only convenience: re-derive an in-place node from its live DOM siblings.
     * Production never calls this — the sync layer resolves tracked anchors itself.
     * @param {Node} startNode
     * @param {Node} [endNode]
     */
    rebuild(startNode: Node, endNode?: Node): void;
}
export type RopeNodeKind = "open" | "text" | "close";
export type RopeNode = {
    text: string;
    weight: number;
    priority: number;
    left: RopeNode | null;
    right: RopeNode | null;
    parent: RopeNode | null;
    domNode: Element | Text;
    kind: RopeNodeKind;
};
export type AtIndexResult = {
    node: RopeNode;
    nodeStart: number;
    offset: number;
};
/**
 * Serialize a *cloned, mutable* element to its clean outerHTML string. The
 * default is native `.outerHTML` (no cleaning); a host (e.g. the TinyMCE plugin)
 * overrides it to strip its internal attributes. Callers always pass a clone, so
 * the hook may mutate it. It must keep native-outerHTML formatting (not run a
 * full HTML serializer) so getOpenTag's close-tag slice stays valid.
 */
export type SerializeNode = (node: Element) => string;
/**
 * Predicate for DOM nodes to omit from the rope entirely — host editing chrome
 * that isn't document content (e.g. TinyMCE's resize handles / bogus nodes). Must
 * be applied identically wherever the DOM is serialized (the rope build here and
 * sync's rangeOuterHtml) or the two representations disagree.
 */
export type OmitNode = (node: Node) => boolean;
/**
 * Predicate for DOM wrappers to traverse *transparently*: their children are kept
 * in the rope but the wrapper itself emits no open/close tags (e.g. TinyMCE's
 * format-caret bookmarks, which wrap real content in a `<span data-mce-type="format-caret">`).
 */
export type UnwrapNode = (node: Node) => boolean;
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
 *
 * Cursor restore resolves an index at the shell's end to the shell's close-tag
 * position, i.e. *inside* the element when it holds local children. With
 * `contenteditable="false"` the browser clamps the caret to the shell's edge, so
 * this only bites a host that leaves the shell editable: keystrokes there are
 * outside the index and are dropped by the opaque filter on the next render.
 *
 * Combining this with a *deep*-cleaning `serializeNode` changes what that hook
 * sees: the non-opaque path hands it one deep clone per region, while opaque
 * subtrees are serialized element-by-element (shallow clones). A host that scrubs
 * nested descendants in `serializeNode` must express the same policy through
 * `omitNode`/`unwrapNode`, which are applied at every level either way.
 */
export type OpaqueNode = (node: Node) => boolean;
