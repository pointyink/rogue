/**
 * Options for {@link attachRogue}. If `wsUrl`, `docId`, and `getToken` are all
 * provided, attachRogue also stands up a sync client (WS + oplog + ack +
 * replay) — the customer-facing path, so plugin users don't have to wire
 * transport themselves. Consumers can still pass their own `onCommit` to intercept
 * (e.g. for offline-only dogfooding); the sync client's send and the user
 * `onCommit` both fire.
 *
 * @typedef {object} AttachOptions
 * @property {(payload: Uint8Array) => void} [onCommit]
 * @property {(bytes: number, limit: number) => void} [onOpTooLarge] Passed through
 *   to the engine — fires when an edit is rejected for exceeding maxOpBytes.
 * @property {() => void} [onDocTooLarge] Passed through to the engine — fires when
 *   an edit can't be applied because the document is at storage capacity.
 * @property {(error: { type: number, name: string, desc?: string }) => void} [onError]
 *   Passed through to the engine — fires when an operation fails for a reason
 *   other than the known limits. Receives the structured WASM error
 *   (`{ type, name, desc? }`, see CrdtErrorKind) so a host can log or toast it.
 * @property {(docId: string) => void} [onDocDeleted] Fired when the doc was
 *   deleted (this client or another); the host should navigate away/clean up.
 * @property {string} [wsUrl]
 * @property {string} [docId]
 * @property {() => Promise<string>} [getToken]
 * @property {boolean} [isNewDoc] True when this call is creating the doc — lets
 *   offline creation claim replica 1 instead of a server round-trip.
 * @property {boolean} [readOnly] True for a viewer — the editor renders and
 *   syncs but never writes (no replica allocation, no sends).
 * @property {(status: 'connecting' | 'connected' | 'disconnected') => void} [onStatus]
 * @property {(progress: number) => void} [onProgress] Fired during the initial
 *   sync (cache replay + WS stream) — progress 0..1 of the doc's bytes applied,
 *   throttled to ~100ms. Pass it through to show a determinate load bar for
 *   large docs.
 * @property {() => void} [onReady] Fired once the doc is loaded and rendered
 *   (interactive). Use it to dismiss a loading overlay.
 * @property {{ render?: (threads: import('@pointyink/rogue').ResolvedThread[]) => void,
 *   onClick?: (commentId: string) => void }} [comments]
 *   Enables comment annotations. `render` receives the resolved threads (comment
 *   + live DOM range) on every change, so the host can render a panel. `onClick`
 *   fires when the cursor lands on a commented range, so the host can pop its
 *   comment dock open to that thread. The endpoint and JWT are handled
 *   internally (derived from `wsUrl` + `docId` + `getToken`). Highlights are
 *   painted in the editor via the CSS Custom Highlight API.
 * @property {{ render?: (suggestions: import('@pointyink/rogue').ResolvedSuggestion[]) => void,
 *   onClick?: (suggestionId: string) => void }} [suggestions]
 *   Enables suggested edits. Same shape as `comments` — `render` receives the
 *   resolved suggestions, `onClick` fires when the cursor lands on a suggested
 *   span (host pops a diff + accept/reject UI). `suggestions.accept(id)` applies
 *   the replacement; `suggestions.create(replacement)` anchors the current
 *   selection; `suggestions.reject(id)` dismisses.
 */
/**
 * Attach a Rogue collab engine to a TinyMCE editor instance. This is a thin
 * adapter: it adapts TinyMCE's surface (getBody/getDoc/getWin, mode, selection,
 * events) for the shared `createEditorSession` in @pointyink/rogue, then wires
 * the TinyMCE-specific undo/IME/normalization hooks. All the collab plumbing
 * (CRDT node, sync client, doc bus, comments) lives in the shared session.
 *
 * @param {any} editor TinyMCE editor (from `tinymce.init({ setup(editor) { ... } })`)
 * @param {AttachOptions} [options]
 * @returns {Promise<{ node: import('@pointyink/rogue').RogueNode, comments: import('@pointyink/rogue').Comments | null, suggestions: import('@pointyink/rogue').Suggestions | null, deleteDoc: () => void }>}
 */
export function attachRogue(editor: any, options?: AttachOptions): Promise<{
    node: import("@pointyink/rogue").RogueNode;
    comments: import("@pointyink/rogue").Comments | null;
    suggestions: import("@pointyink/rogue").Suggestions | null;
    deleteDoc: () => void;
}>;
/**
 * Options for {@link attachRogue}. If `wsUrl`, `docId`, and `getToken` are all
 * provided, attachRogue also stands up a sync client (WS + oplog + ack +
 * replay) — the customer-facing path, so plugin users don't have to wire
 * transport themselves. Consumers can still pass their own `onCommit` to intercept
 * (e.g. for offline-only dogfooding); the sync client's send and the user
 * `onCommit` both fire.
 */
export type AttachOptions = {
    onCommit?: ((payload: Uint8Array) => void) | undefined;
    /**
     * Passed through
     * to the engine — fires when an edit is rejected for exceeding maxOpBytes.
     */
    onOpTooLarge?: ((bytes: number, limit: number) => void) | undefined;
    /**
     * Passed through to the engine — fires when
     * an edit can't be applied because the document is at storage capacity.
     */
    onDocTooLarge?: (() => void) | undefined;
    /**
     * Passed through to the engine — fires when an operation fails for a reason
     * other than the known limits. Receives the structured WASM error
     * (`{ type, name, desc? }`, see CrdtErrorKind) so a host can log or toast it.
     */
    onError?: ((error: {
        type: number;
        name: string;
        desc?: string;
    }) => void) | undefined;
    /**
     * Fired when the doc was
     * deleted (this client or another); the host should navigate away/clean up.
     */
    onDocDeleted?: ((docId: string) => void) | undefined;
    wsUrl?: string | undefined;
    docId?: string | undefined;
    getToken?: (() => Promise<string>) | undefined;
    /**
     * True when this call is creating the doc — lets
     * offline creation claim replica 1 instead of a server round-trip.
     */
    isNewDoc?: boolean | undefined;
    /**
     * True for a viewer — the editor renders and
     * syncs but never writes (no replica allocation, no sends).
     */
    readOnly?: boolean | undefined;
    onStatus?: ((status: "connecting" | "connected" | "disconnected") => void) | undefined;
    /**
     * Fired during the initial
     * sync (cache replay + WS stream) — progress 0..1 of the doc's bytes applied,
     * throttled to ~100ms. Pass it through to show a determinate load bar for
     * large docs.
     */
    onProgress?: ((progress: number) => void) | undefined;
    /**
     * Fired once the doc is loaded and rendered
     * (interactive). Use it to dismiss a loading overlay.
     */
    onReady?: (() => void) | undefined;
    /**
     * Enables comment annotations. `render` receives the resolved threads (comment
     * + live DOM range) on every change, so the host can render a panel. `onClick`
     * fires when the cursor lands on a commented range, so the host can pop its
     * comment dock open to that thread. The endpoint and JWT are handled
     * internally (derived from `wsUrl` + `docId` + `getToken`). Highlights are
     * painted in the editor via the CSS Custom Highlight API.
     */
    comments?: {
        render?: (threads: import("@pointyink/rogue").ResolvedThread[]) => void;
        onClick?: (commentId: string) => void;
    } | undefined;
    /**
     * Enables suggested edits. Same shape as `comments` — `render` receives the
     * resolved suggestions, `onClick` fires when the cursor lands on a suggested
     * span (host pops a diff + accept/reject UI). `suggestions.accept(id)` applies
     * the replacement; `suggestions.create(replacement)` anchors the current
     * selection; `suggestions.reject(id)` dismisses.
     */
    suggestions?: {
        render?: (suggestions: import("@pointyink/rogue").ResolvedSuggestion[]) => void;
        onClick?: (suggestionId: string) => void;
    } | undefined;
};
