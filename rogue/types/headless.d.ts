/**
 * Parse `html` and re-serialize it through the rope's canonical form (the same
 * scrub + escape the CRDT render uses). Reports whether it round-trips un-mangled
 * and what it normalizes to.
 * @param {string} html @param {Document} doc
 * @param {import('./dom_rope.js').OpaqueNode} [opaqueNode] An opaque element's
 *   children are dropped before they reach the CRDT, so they must be dropped
 *   from the round-trip too — otherwise a widget's local markup (a table that
 *   normalizes to <tbody>, say) rejects a write that would have stored cleanly.
 * @returns {{ ok: boolean, cleaned: string }}
 */
export function roundTripHtml(html: string, doc: Document, opaqueNode?: import("./dom_rope.js").OpaqueNode): {
    ok: boolean;
    cleaned: string;
};
/**
 * DOM-free HTML round-trip check via parse5 — the parser jsdom is built on.
 * Same fixed-point semantics as `validHtml` (parse the fragment in `context`'s
 * tag, serialize, compare) but ~7× faster because it skips DOM construction.
 * The headless replica uses this for HTML validation (the single load check and
 * steady-state scoped checks); the browser keeps the native `validHtml`.
 * @param {string} html
 * @param {Element} [context]
 * @returns {boolean}
 */
export function parse5ValidHtml(html: string, context?: Element): boolean;
/**
 * Create a headless editor (a CRDT replica over a jsdom <div>).
 *
 * Pass `doc`/`win`/`element` to bind an existing jsdom (e.g. the MCP server owns
 * the jsdom + sync client); otherwise a fresh jsdom is created.
 *
 * @param {{ replicaId?: number, onCommit?: (payload: Uint8Array) => void, doc?: Document, win?: Window, element?: HTMLElement, opaqueNode?: import('./dom_rope.js').OpaqueNode }} [options]
 * @returns {Promise<HeadlessEditor>}
 */
export function createHeadlessEditor({ replicaId, onCommit, doc, win, element, opaqueNode }?: {
    replicaId?: number;
    onCommit?: (payload: Uint8Array) => void;
    doc?: Document;
    win?: Window;
    element?: HTMLElement;
    opaqueNode?: import("./dom_rope.js").OpaqueNode;
}): Promise<HeadlessEditor>;
export type HeadlessEditor = {
    node: import("./sync.js").RogueNode;
    element: HTMLElement;
    getHtml: () => string;
    getVisLen: () => number;
    validate: (html: string) => {
        ok: boolean;
        cleaned: string;
    };
    setHtml: (html: string) => Promise<{
        ok: boolean;
        cleaned?: string;
        html?: string;
    }>;
    appendHtml: (html: string) => Promise<{
        ok: boolean;
        cleaned?: string;
        html?: string;
    }>;
    undo: () => void;
    redo: () => void;
    mergeOp: (payload: Uint8Array) => void;
    markUserEdit: () => void;
    subscribe: (cb: (payload: Uint8Array) => void) => () => boolean;
    assertConsistent: () => {
        ok: boolean;
        crdt: string;
        dom: string;
    };
    destroy: () => void;
};
