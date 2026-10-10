/** @typedef {{ id: string, author_id: string, start_id: string, end_id: string,
 *   message: string, resolved: boolean, created_at: string, updated_at: string,
 *   replies: Reply[] }} Comment
 * @typedef {{ id: string, author_id: string, message: string, created_at: string }} Reply
 * @typedef {{ startNode: Node, startOffset: number, endNode: Node, endOffset: number }} DomRange
 * @typedef {Comment & { range: DomRange | null }} ResolvedThread
 */
/**
 * The CRDT/node-id ⇄ vis-index surface a Rogue node exposes for annotations.
 * @typedef {{ visIxOf(id: string): number | null, idAtVisIx(ix: number): string | null,
 *   nextVisId(id: string): string | null, prevVisId(id: string): string | null,
 *   visLen(): number }} CrdtSurface
 */
/**
 * The DOM rope surface a Rogue node exposes — vis-index ⇄ DOM-position mapping.
 * @typedef {{ visIxToDomPos(ix: number): { node: Node, offset: number } | null,
 *   domPosToVisIx(node: Node, offset: number): number | null,
 *   getAtVisIx(ix: number): import('./dom_rope.js').AtIndexResult | null }} RopeSurface
 */
/**
 * A minimal fetch-like function returning just what this module reads.
 * @typedef {(input: string, init?: RequestInit) => Promise<{
 *   ok: boolean, status: number, json: () => Promise<any>,
 * }>} CommentsFetcher
 */
/**
 * @typedef {{
 *   crdt: CrdtSurface,
 *   rope: RopeSurface,
 *   baseUrl: string,
 *   fetchFn?: CommentsFetcher,
 *   rerender?: (threads: ResolvedThread[]) => void,
 *   onError?: (error: Error) => void,
 *   getSelectionRange?: () => DomRange | null,
 * }} CommentsOptions
 */
/**
 * @typedef {{
 *   load: () => Promise<ResolvedThread[]>,
 *   threads: () => ResolvedThread[],
 *   create: (message: string) => Promise<void>,
 *   reply: (commentId: string, message: string) => Promise<void>,
 *   update: (commentId: string, patch: { message?: string, resolved?: boolean }) => Promise<void>,
 *   remove: (commentId: string) => Promise<void>,
 *   handleDocumentChange: (range: { minIx: number, maxIx: number } | null) => void,
 *   handleRemoteChange: () => Promise<ResolvedThread[]>,
 *   destroy: () => void,
 * }} Comments
 */
/** The DOM position just past the last character of a non-empty doc.
 *  @param {RopeSurface} rope @param {number} visLen
 *  @returns {{ node: Node, offset: number } | null} */
export function endOfDocPos(rope: RopeSurface, visLen: number): {
    node: Node;
    offset: number;
} | null;
/** Resolve a node-id anchor to a live DOM range, or null if the anchor is stale
 *  (an endpoint was deleted) or the doc is empty.
 *  @param {CrdtSurface} crdt @param {RopeSurface} rope
 *  @param {string} startId @param {string} endId
 *  @returns {DomRange | null} */
export function resolveAnchor(crdt: CrdtSurface, rope: RopeSurface, startId: string, endId: string): DomRange | null;
/** Capture a DOM range as a node-id anchor (inclusive start/end char ids), or
 *  null for an empty/collapsed range.
 *  @param {CrdtSurface} crdt @param {RopeSurface} rope
 *  @param {DomRange} range
 *  @returns {{ start_id: string, end_id: string } | null} */
export function anchorForRange(crdt: CrdtSurface, rope: RopeSurface, range: DomRange): {
    start_id: string;
    end_id: string;
} | null;
/**
 * @param {CommentsOptions} options
 * @returns {Comments}
 */
export function createComments({ crdt, rope, baseUrl, fetchFn, rerender, onError, getSelectionRange }: CommentsOptions): Comments;
export type Comment = {
    id: string;
    author_id: string;
    start_id: string;
    end_id: string;
    message: string;
    resolved: boolean;
    created_at: string;
    updated_at: string;
    replies: Reply[];
};
export type Reply = {
    id: string;
    author_id: string;
    message: string;
    created_at: string;
};
export type DomRange = {
    startNode: Node;
    startOffset: number;
    endNode: Node;
    endOffset: number;
};
export type ResolvedThread = Comment & {
    range: DomRange | null;
};
/**
 * The CRDT/node-id ⇄ vis-index surface a Rogue node exposes for annotations.
 */
export type CrdtSurface = {
    visIxOf(id: string): number | null;
    idAtVisIx(ix: number): string | null;
    nextVisId(id: string): string | null;
    prevVisId(id: string): string | null;
    visLen(): number;
};
/**
 * The DOM rope surface a Rogue node exposes — vis-index ⇄ DOM-position mapping.
 */
export type RopeSurface = {
    visIxToDomPos(ix: number): {
        node: Node;
        offset: number;
    } | null;
    domPosToVisIx(node: Node, offset: number): number | null;
    getAtVisIx(ix: number): import("./dom_rope.js").AtIndexResult | null;
};
/**
 * A minimal fetch-like function returning just what this module reads.
 */
export type CommentsFetcher = (input: string, init?: RequestInit) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<any>;
}>;
export type CommentsOptions = {
    crdt: CrdtSurface;
    rope: RopeSurface;
    baseUrl: string;
    fetchFn?: CommentsFetcher;
    rerender?: (threads: ResolvedThread[]) => void;
    onError?: (error: Error) => void;
    getSelectionRange?: () => DomRange | null;
};
export type Comments = {
    load: () => Promise<ResolvedThread[]>;
    threads: () => ResolvedThread[];
    create: (message: string) => Promise<void>;
    reply: (commentId: string, message: string) => Promise<void>;
    update: (commentId: string, patch: {
        message?: string;
        resolved?: boolean;
    }) => Promise<void>;
    remove: (commentId: string) => Promise<void>;
    handleDocumentChange: (range: {
        minIx: number;
        maxIx: number;
    } | null) => void;
    handleRemoteChange: () => Promise<ResolvedThread[]>;
    destroy: () => void;
};
