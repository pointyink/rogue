/**
 * @param {SyncClientOptions} options
 * @returns {SyncClient}
 */
export function createSyncClient({ wsUrl, docId, mergeOp, getToken, onStatus, onReady, onSyncStart, onProgress, onCommentChanged, onSuggestionChanged, onDocDeleted }: SyncClientOptions): SyncClient;
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
};
export type SyncClient = {
    send: (payload: Uint8Array) => void;
    sendDelete: () => void;
    destroy: () => void;
    isReady: () => boolean;
};
