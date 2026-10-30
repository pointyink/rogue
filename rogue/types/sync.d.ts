/**
 * Whether an HTML string survives a browser-parse round-trip unchanged. `context`
 * is an element whose *tag* supplies the parse context — pass the region's parent
 * so `<td>`/`<tr>`/`<li>` parse in their real context (a bare `<div>` would drop
 * table internals). Omitted → a bare `<div>`. Raw innerHTML is used (not the
 * rope+scrub serialization) because the CRDT render is already clean (scrubbed +
 * escaped). Exported for direct tests.
 * @param {string} html
 * @param {Element} [context]
 * @returns {boolean}
 */
export function validHtml(html: string, context?: Element): boolean;
/**
 * The vis-index span a reference node contributes to a scoped-sync range, robust
 * to the DOM churning mid-batch (see localRegion):
 *  - tracked + attached → its stable pre-mutation rope range.
 *  - new + attached     → walk the live DOM to tracked neighbours, or an edge.
 *  - detached           → nothing (its removal is bracketed by surviving siblings;
 *    an added-then-removed node is a net no-op). Never maps min/max onto a
 *    detached node — that's the trailing-content-duplication failure.
 * A boundary that runs off the doc edge is reported as `startEdge`/`endEdge` rather
 * than index 0/len-1, which could resolve back to a just-detached node.
 * @internal
 * @param {NonNullable<ReturnType<typeof buildRope>>} rope
 * @param {Node} node
 * @returns {{ minIx?: number, maxIx?: number, startEdge?: boolean, endEdge?: boolean }}
 */
export function nodeSpan(rope: NonNullable<ReturnType<typeof buildRope>>, node: Node): {
    minIx?: number;
    maxIx?: number;
    startEdge?: boolean;
    endEdge?: boolean;
};
/**
 * @typedef {object} RogueNodeOptions
 * @property {HTMLElement} element  The container the engine renders into and
 *   observes. It does NOT need `contenteditable` — making it editable is the
 *   host's responsibility (and is what triggers the local-edit sync path); a
 *   read-only renderer that only calls `mergeOp` works with any element. Pass a
 *   matching `doc`/`win` when the element lives in another realm (TinyMCE's iframe).
 * @property {number} [replicaId] This replica's id in the CRDT (defaults to a
 *   random u16). Override it to keep a stable identity across reloads — per-author
 *   undo, presence, and cursor attribution key off it — or to coordinate ids
 *   server-side so concurrent replicas never collide (the u16 space is ~65k).
 * @property {(payload: Uint8Array) => void} [onCommit]
 * @property {number} [maxOpBytes = 8388608] Hard cap on a single committed op
 *   batch (one edit = one wire frame). An edit whose inserts exceed this is
 *   rejected — `onOpTooLarge` fires and the DOM is reverted to the CRDT — so a
 *   pathological paste (or programmatic insert) can't blow the server's read
 *   limit. The server (WS_MAX_MESSAGE_SIZE) remains the precise backstop; this
 *   guard is the friendly first line for any host, whether or not it uses the
 *   engine's own paste listener.
 * @property {(bytes: number, limit: number) => void} [onOpTooLarge] Called when
 *   an edit is rejected for exceeding `maxOpBytes`.
 * @property {() => void} [onDocTooLarge] Called when an edit can't be applied
 *   because the document has reached its storage capacity. The edit is reverted
 *   (the CRDT is left untouched).
 * @property {{ ops?: number, opBytes?: number, crdtBytes?: number }} [sizeWarn]
 *   Soft size thresholds. When a configured metric crosses its threshold,
 *   `onSizeWarning` fires — once per crossing, re-armed when the metric falls
 *   back below half the threshold. Nothing is enforced: the edit still applies,
 *   and the host decides what to do (banner, go read-only, offer an export).
 *   Prefer `ops`: a legitimate large paste is one big op, whereas duplication
 *   shows up as an op-count blow-up.
 * @property {(stats: NodeStats, key: 'ops' | 'opBytes' | 'crdtBytes') => void} [onSizeWarning]
 *   Called with the full stats when a `sizeWarn` threshold is first crossed.
 * @property {(error: import('./crdt_error.js').CrdtError) => void} [onError]
 *   Called when an operation fails for a reason other than the known limits
 *   above — receives the structured error the WASM wrote into its output buffer
 *   (`{ type, name, desc? }`, see CrdtErrorKind), so a host can log or toast it.
 *   `out_of_memory` on the local commit path continues to route through
 *   `onDocTooLarge`.
 * @property {(range: { minIx: number, maxIx: number } | null) => void} [onChange]
 *   Called after the document's visible text changes (local edits, remote ops,
 *   undo/redo) with the affected vis-index range, or null when it can't be
 *   localized. Internal to the rogue layer — comments.js uses it to re-resolve
 *   anchored ranges; hosts generally don't need it.
 * @property {false | { maxBytes?: number, onRejected?: (bytes: number, limit: number) => void }} [paste]
 *   Paste handling. `false` skips the engine's own paste listener — hosts like
 *   TinyMCE have their own paste-clean pipeline, so running both would double-insert.
 *   An object enables it, optionally capping size (`maxBytes`) and reporting
 *   rejections (`onRejected`). Omit for the engine to handle paste with no cap.
 * @property {Document} [doc] Host abstraction — defaults work for a standard
 *   contenteditable in the main window. The TinyMCE binding overrides doc/win to
 *   operate inside the editor's iframe.
 * @property {Window} [win]
 * @property {import('./dom_rope.js').SerializeNode} [serializeNode] Host hook to
 *   serialize a (cloned) element to clean outerHTML — defaults to native
 *   `.outerHTML`. The TinyMCE host overrides it to strip `data-mce-*` so its
 *   internal attributes never enter the CRDT.
 * @property {import('./dom_rope.js').OmitNode} [omitNode] Host predicate for DOM
 *   nodes to omit entirely — editing chrome that isn't content (e.g. TinyMCE's
 *   resize handles / bogus nodes). Applied in both the rope build and the diff's
 *   DOM serializer so the CRDT never sees them.
 * @property {import('./dom_rope.js').UnwrapNode} [unwrapNode] Host
 *   predicate for wrappers to traverse transparently — their children are kept,
 *   the wrapper's own open/close tags are dropped (e.g. TinyMCE's format-caret
 *   bookmarks, which wrap real content).
 * @property {(html: string, context?: Element) => boolean} [validateHtml]
 *   The HTML round-trip predicate used to validate ops. Defaults to the native
 *   `validHtml` (clone the context tag + `innerHTML` round-trip). The headless
 *   replica overrides it with a DOM-free `parse5` implementation — same
 *   fixed-point semantics, ~7× faster because it skips DOM construction.
 */
/**
 * Cheap (O(1)) size and integrity numbers for a live node. `crdtBytes` is the
 * CRDT arena's real footprint; it does NOT include the DOM rope or the rendered
 * DOM, which are JS heap and have no portable per-doc measure.
 * @typedef {object} NodeStats
 * @property {number} visLen      Visible UTF-16 code units.
 * @property {number} ops         Applied op groups retained for the fold.
 * @property {number} opBytes     Bytes of those retained op payloads (JS heap).
 * @property {number} crdtBytes   Bytes the CRDT arena holds in WASM.
 * @property {number} parked      Ops parked, waiting on a missing dependency.
 * @property {number} parkedDropped  Ops dropped at the parked cap. Non-zero means
 *   the CRDT is missing history — the doc should be exported and reloaded.
 */
/**
 * @typedef {{
 *   mergeOp: (payload: Uint8Array) => void,
 *   undo: () => void,
 *   redo: () => void,
 *   beginLoad: () => void,
 *   endLoad: () => void,
 *   drainParked: () => void,
 *   setSyncDebug: (on: boolean) => void,
 *   setAuthor: (author: number) => void,
 *   markUserEdit: () => void,
 *   reserve: (nodes: number) => void,
 *   stats: () => NodeStats,
 *   getString: () => string,
 *   exportOps: () => { gid: { replica: number, seq: number }, payload: Uint8Array }[],
 *   assertConsistent: () => { ok: boolean, crdt: string, dom: string },
 *   crdt: import('./comments.js').CrdtSurface,
 *   rope: import('./dom_rope.js').DomRope,
 *   destroy: () => void,
 * }} RogueNode
 */
/**
 * @param {RogueNodeOptions} options
 * @returns {Promise<RogueNode>}
 */
export function createRogueNode({ element: editorRoot, replicaId, onCommit, maxOpBytes, onOpTooLarge, onDocTooLarge, sizeWarn, onSizeWarning, onError, onChange, paste, doc, win, serializeNode, omitNode, unwrapNode, validateHtml, }: RogueNodeOptions): Promise<RogueNode>;
export type RogueNodeOptions = {
    /**
     * The container the engine renders into and
     * observes. It does NOT need `contenteditable` — making it editable is the
     * host's responsibility (and is what triggers the local-edit sync path); a
     * read-only renderer that only calls `mergeOp` works with any element. Pass a
     * matching `doc`/`win` when the element lives in another realm (TinyMCE's iframe).
     */
    element: HTMLElement;
    /**
     * This replica's id in the CRDT (defaults to a
     * random u16). Override it to keep a stable identity across reloads — per-author
     * undo, presence, and cursor attribution key off it — or to coordinate ids
     * server-side so concurrent replicas never collide (the u16 space is ~65k).
     */
    replicaId?: number | undefined;
    onCommit?: ((payload: Uint8Array) => void) | undefined;
    /**
     * Hard cap on a single committed op
     * batch (one edit = one wire frame). An edit whose inserts exceed this is
     * rejected — `onOpTooLarge` fires and the DOM is reverted to the CRDT — so a
     * pathological paste (or programmatic insert) can't blow the server's read
     * limit. The server (WS_MAX_MESSAGE_SIZE) remains the precise backstop; this
     * guard is the friendly first line for any host, whether or not it uses the
     * engine's own paste listener.
     */
    maxOpBytes?: number | undefined;
    /**
     * Called when
     * an edit is rejected for exceeding `maxOpBytes`.
     */
    onOpTooLarge?: ((bytes: number, limit: number) => void) | undefined;
    /**
     * Called when an edit can't be applied
     * because the document has reached its storage capacity. The edit is reverted
     * (the CRDT is left untouched).
     */
    onDocTooLarge?: (() => void) | undefined;
    /**
     * Soft size thresholds. When a configured metric crosses its threshold,
     * `onSizeWarning` fires — once per crossing, re-armed when the metric falls
     * back below half the threshold. Nothing is enforced: the edit still applies,
     * and the host decides what to do (banner, go read-only, offer an export).
     * Prefer `ops`: a legitimate large paste is one big op, whereas duplication
     * shows up as an op-count blow-up.
     */
    sizeWarn?: {
        ops?: number;
        opBytes?: number;
        crdtBytes?: number;
    } | undefined;
    /**
     * Called with the full stats when a `sizeWarn` threshold is first crossed.
     */
    onSizeWarning?: ((stats: NodeStats, key: "ops" | "opBytes" | "crdtBytes") => void) | undefined;
    /**
     * Called when an operation fails for a reason other than the known limits
     * above — receives the structured error the WASM wrote into its output buffer
     * (`{ type, name, desc? }`, see CrdtErrorKind), so a host can log or toast it.
     * `out_of_memory` on the local commit path continues to route through
     * `onDocTooLarge`.
     */
    onError?: ((error: import("./crdt_error.js").CrdtError) => void) | undefined;
    /**
     * Called after the document's visible text changes (local edits, remote ops,
     * undo/redo) with the affected vis-index range, or null when it can't be
     * localized. Internal to the rogue layer — comments.js uses it to re-resolve
     * anchored ranges; hosts generally don't need it.
     */
    onChange?: ((range: {
        minIx: number;
        maxIx: number;
    } | null) => void) | undefined;
    /**
     * Paste handling. `false` skips the engine's own paste listener — hosts like
     * TinyMCE have their own paste-clean pipeline, so running both would double-insert.
     * An object enables it, optionally capping size (`maxBytes`) and reporting
     * rejections (`onRejected`). Omit for the engine to handle paste with no cap.
     */
    paste?: false | {
        maxBytes?: number;
        onRejected?: (bytes: number, limit: number) => void;
    } | undefined;
    /**
     * Host abstraction — defaults work for a standard
     * contenteditable in the main window. The TinyMCE binding overrides doc/win to
     * operate inside the editor's iframe.
     */
    doc?: Document | undefined;
    win?: Window | undefined;
    /**
     * Host hook to
     * serialize a (cloned) element to clean outerHTML — defaults to native
     * `.outerHTML`. The TinyMCE host overrides it to strip `data-mce-*` so its
     * internal attributes never enter the CRDT.
     */
    serializeNode?: import("./dom_rope.js").SerializeNode | undefined;
    /**
     * Host predicate for DOM
     * nodes to omit entirely — editing chrome that isn't content (e.g. TinyMCE's
     * resize handles / bogus nodes). Applied in both the rope build and the diff's
     * DOM serializer so the CRDT never sees them.
     */
    omitNode?: import("./dom_rope.js").OmitNode | undefined;
    /**
     * Host
     * predicate for wrappers to traverse transparently — their children are kept,
     * the wrapper's own open/close tags are dropped (e.g. TinyMCE's format-caret
     * bookmarks, which wrap real content).
     */
    unwrapNode?: import("./dom_rope.js").UnwrapNode | undefined;
    /**
     * The HTML round-trip predicate used to validate ops. Defaults to the native
     * `validHtml` (clone the context tag + `innerHTML` round-trip). The headless
     * replica overrides it with a DOM-free `parse5` implementation — same
     * fixed-point semantics, ~7× faster because it skips DOM construction.
     */
    validateHtml?: ((html: string, context?: Element) => boolean) | undefined;
};
/**
 * Cheap (O(1)) size and integrity numbers for a live node. `crdtBytes` is the
 * CRDT arena's real footprint; it does NOT include the DOM rope or the rendered
 * DOM, which are JS heap and have no portable per-doc measure.
 */
export type NodeStats = {
    /**
     * Visible UTF-16 code units.
     */
    visLen: number;
    /**
     * Applied op groups retained for the fold.
     */
    ops: number;
    /**
     * Bytes of those retained op payloads (JS heap).
     */
    opBytes: number;
    /**
     * Bytes the CRDT arena holds in WASM.
     */
    crdtBytes: number;
    /**
     * Ops parked, waiting on a missing dependency.
     */
    parked: number;
    /**
     * Ops dropped at the parked cap. Non-zero means
     * the CRDT is missing history — the doc should be exported and reloaded.
     */
    parkedDropped: number;
};
export type RogueNode = {
    mergeOp: (payload: Uint8Array) => void;
    undo: () => void;
    redo: () => void;
    beginLoad: () => void;
    endLoad: () => void;
    drainParked: () => void;
    setSyncDebug: (on: boolean) => void;
    setAuthor: (author: number) => void;
    markUserEdit: () => void;
    reserve: (nodes: number) => void;
    stats: () => NodeStats;
    getString: () => string;
    exportOps: () => {
        gid: {
            replica: number;
            seq: number;
        };
        payload: Uint8Array;
    }[];
    assertConsistent: () => {
        ok: boolean;
        crdt: string;
        dom: string;
    };
    crdt: import("./comments.js").CrdtSurface;
    rope: import("./dom_rope.js").DomRope;
    destroy: () => void;
};
import { buildRope } from "./dom_rope.js";
