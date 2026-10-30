/**
 * @param {SyncClientOptions} options
 * @returns {SyncClient}
 */
export function createSyncClient({ wsUrl, docId, mergeOp, getToken, onStatus, onReady, onSyncStart, onProgress, onCommentChanged, onSuggestionChanged, onDocDeleted, persist }: SyncClientOptions): SyncClient;
/**
 * `persist` defaults to true: every merged op is appended to the IndexedDB doc
 * cache so a browser reload can resume offline. Server-side replicas that never
 * reload from local storage should pass false — the per-op cache writes dominate
 * cold-load time at scale, and the cache only grows for the process lifetime.
 */
export type SyncStatus = "connecting" | "connected" | "disconnected";
export type SyncClientOptions = {
    wsUrl: string;
    docId: string;
    mergeOp: (payload: Uint8Array) => void;
    getToken: () => Promise<string>;
    onStatus?: (status: SyncStatus) => void;
    onReady?: () => void;
    onSyncStart?: (bytes: number) => void;
    onProgress?: (progress: number) => void;
    onCommentChanged?: (info: {
        comment_id: string;
        op: string;
    }) => void;
    onSuggestionChanged?: (info: {
        suggestion_id: string;
        op: string;
    }) => void;
    onDocDeleted?: (docId: string) => void;
    persist?: boolean;
};
export type SyncClient = {
    send: (payload: Uint8Array) => void;
    sendDelete: () => void;
    destroy: () => void;
    isReady: () => boolean;
    pendingCount: () => Promise<number>;
};
