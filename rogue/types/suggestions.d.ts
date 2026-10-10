/**
 * @typedef {{ id: string, author_id: string, start_id: string, end_id: string,
 *   replacement: string, status: string, created_at: string, updated_at: string }} Suggestion
 * @typedef {Suggestion & { range: import('./comments.js').DomRange | null }} ResolvedSuggestion
 */
/**
 * Resolve a suggestion's node-id anchor to a live DOM range with fencepost
 * semantics. Unlike comments, a suggestion brackets a *region*: if a boundary
 * char is edited away, the range steps inward to the nearest surviving visible
 * node (next_vis for the left edge, prev_vis for the right) rather than going
 * stale. Null only when the region between the ids has fully collapsed.
 *
 * @param {import('./comments.js').CrdtSurface} crdt
 * @param {import('./comments.js').RopeSurface} rope
 * @param {string} startId @param {string} endId
 * @returns {import('./comments.js').DomRange | null}
 */
export function resolveSuggestionAnchor(crdt: import("./comments.js").CrdtSurface, rope: import("./comments.js").RopeSurface, startId: string, endId: string): import("./comments.js").DomRange | null;
/**
 * @typedef {{
 *   crdt: import('./comments.js').CrdtSurface,
 *   rope: import('./comments.js').RopeSurface,
 *   baseUrl: string,
 *   fetchFn?: import('./comments.js').CommentsFetcher,
 *   rerender?: (suggestions: ResolvedSuggestion[]) => void,
 *   onError?: (error: Error) => void,
 *   markUserEdit?: () => void,
 *   getSelectionRange?: () => import('./comments.js').DomRange | null,
 * }} SuggestionsOptions
 */
/**
 * @typedef {{
 *   load: () => Promise<ResolvedSuggestion[]>,
 *   suggestions: () => ResolvedSuggestion[],
 *   create: (replacement: string) => Promise<void>,
 *   accept: (suggestionId: string) => Promise<void>,
 *   reject: (suggestionId: string) => Promise<void>,
 *   handleDocumentChange: (range: { minIx: number, maxIx: number } | null) => void,
 *   handleRemoteChange: () => Promise<ResolvedSuggestion[]>,
 *   destroy: () => void,
 * }} Suggestions
 */
/**
 * @param {SuggestionsOptions} options
 * @returns {Suggestions}
 */
export function createSuggestions({ crdt, rope, baseUrl, fetchFn, rerender, onError, markUserEdit, getSelectionRange }: SuggestionsOptions): Suggestions;
export type Suggestion = {
    id: string;
    author_id: string;
    start_id: string;
    end_id: string;
    replacement: string;
    status: string;
    created_at: string;
    updated_at: string;
};
export type ResolvedSuggestion = Suggestion & {
    range: import("./comments.js").DomRange | null;
};
export type SuggestionsOptions = {
    crdt: import("./comments.js").CrdtSurface;
    rope: import("./comments.js").RopeSurface;
    baseUrl: string;
    fetchFn?: import("./comments.js").CommentsFetcher;
    rerender?: (suggestions: ResolvedSuggestion[]) => void;
    onError?: (error: Error) => void;
    markUserEdit?: () => void;
    getSelectionRange?: () => import("./comments.js").DomRange | null;
};
export type Suggestions = {
    load: () => Promise<ResolvedSuggestion[]>;
    suggestions: () => ResolvedSuggestion[];
    create: (replacement: string) => Promise<void>;
    accept: (suggestionId: string) => Promise<void>;
    reject: (suggestionId: string) => Promise<void>;
    handleDocumentChange: (range: {
        minIx: number;
        maxIx: number;
    } | null) => void;
    handleRemoteChange: () => Promise<ResolvedSuggestion[]>;
    destroy: () => void;
};
