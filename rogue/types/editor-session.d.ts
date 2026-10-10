/**
 * The editor surface a host adapts for the shared session. Host-specific.
 * @typedef {{
 *   element: HTMLElement,
 *   doc: Document,
 *   win: Window,
 *   serializeNode: import('./dom_rope.js').SerializeNode,
 *   omitNode: import('./dom_rope.js').OmitNode,
 *   unwrapNode: import('./dom_rope.js').UnwrapNode,
 *   setMode: (mode: 'design' | 'readonly') => void,
 *   getCollapsedSelection: () => { node: Node, offset: number } | null,
 *   getSelectionRange: () => import('./comments.js').DomRange | null,
 *   onClick: (handler: () => void) => void,
 * }} EditorSurface
 */
/**
 * @typedef {EditorSurface & {
 *   paste?: false | object,
 *   wsUrl?: string,
 *   docId?: string,
 *   getToken?: () => Promise<string>,
 *   isNewDoc?: boolean,
 *   readOnly?: boolean,
 *   onStatus?: (status: import('./sync-client.js').SyncStatus) => void,
 *   onProgress?: (progress: number) => void,
 *   onReady?: () => void,
 *   onCommit?: (payload: Uint8Array) => void,
 *   onOpTooLarge?: (bytes: number, limit: number) => void,
 *   onDocTooLarge?: () => void,
 *   onError?: (error: import('./crdt_error.js').CrdtError) => void,
 *   onDocDeleted?: (docId: string) => void,
 *   comments?: {
 *     render?: (threads: import('./comments.js').ResolvedThread[]) => void,
 *     onClick?: (commentId: string) => void,
 *   },
 *   suggestions?: {
 *     render?: (suggestions: import('./suggestions.js').ResolvedSuggestion[]) => void,
 *     onClick?: (suggestionId: string) => void,
 *   },
 * }} EditorSessionOptions
 */
/**
 * Stand up a collaborative editing session against an editor host. Returns the
 * engine node and (if enabled) the comments/suggestions APIs.
 *
 * @param {EditorSessionOptions} options
 * @returns {Promise<{ node: import('./sync.js').RogueNode, comments: import('./comments.js').Comments | null, suggestions: import('./suggestions.js').Suggestions | null, deleteDoc: () => void }>}
 */
export function createEditorSession({ element, doc, win, serializeNode, omitNode, unwrapNode, setMode, getCollapsedSelection, getSelectionRange, onClick, paste, wsUrl, docId, getToken, isNewDoc, readOnly, onStatus, onProgress, onReady, onCommit, onOpTooLarge, onDocTooLarge, onError, onDocDeleted, comments: commentsOpt, suggestions: suggestionsOpt, }: EditorSessionOptions): Promise<{
    node: import("./sync.js").RogueNode;
    comments: import("./comments.js").Comments | null;
    suggestions: import("./suggestions.js").Suggestions | null;
    deleteDoc: () => void;
}>;
/**
 * The editor surface a host adapts for the shared session. Host-specific.
 */
export type EditorSurface = {
    element: HTMLElement;
    doc: Document;
    win: Window;
    serializeNode: import("./dom_rope.js").SerializeNode;
    omitNode: import("./dom_rope.js").OmitNode;
    unwrapNode: import("./dom_rope.js").UnwrapNode;
    setMode: (mode: "design" | "readonly") => void;
    getCollapsedSelection: () => {
        node: Node;
        offset: number;
    } | null;
    getSelectionRange: () => import("./comments.js").DomRange | null;
    onClick: (handler: () => void) => void;
};
export type EditorSessionOptions = EditorSurface & {
    paste?: false | object;
    wsUrl?: string;
    docId?: string;
    getToken?: () => Promise<string>;
    isNewDoc?: boolean;
    readOnly?: boolean;
    onStatus?: (status: import("./sync-client.js").SyncStatus) => void;
    onProgress?: (progress: number) => void;
    onReady?: () => void;
    onCommit?: (payload: Uint8Array) => void;
    onOpTooLarge?: (bytes: number, limit: number) => void;
    onDocTooLarge?: () => void;
    onError?: (error: import("./crdt_error.js").CrdtError) => void;
    onDocDeleted?: (docId: string) => void;
    comments?: {
        render?: (threads: import("./comments.js").ResolvedThread[]) => void;
        onClick?: (commentId: string) => void;
    };
    suggestions?: {
        render?: (suggestions: import("./suggestions.js").ResolvedSuggestion[]) => void;
        onClick?: (suggestionId: string) => void;
    };
};
