/**
 * Omit a node and its subtree entirely: whole chrome containers (resize handles,
 * resizer bars, `data-mce-bogus="all"`). Everything else is content.
 * @param {Node} node
 * @returns {boolean}
 */
export function omitNode(node: Node): boolean;
/**
 * A transparent wrapper: traverse its children but emit no open/close tags for
 * the wrapper itself — TinyMCE's format-caret bookmark wraps real content in a
 * `<span data-mce-type="format-caret">`.
 * @param {Node} node
 * @returns {boolean}
 */
export function unwrapNode(node: Node): boolean;
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
export function serializeNode(node: Node): string;
