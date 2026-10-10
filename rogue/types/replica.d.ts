/**
 * Derive the sync host's HTTPS origin from a ws(s) URL like
 * `wss://sync.example.com/ws/<docId>`.
 * @param {string} wsUrl
 * @returns {string}
 */
export function syncBaseUrlFromWsUrl(wsUrl: string): string;
/**
 * Read the persisted replica id for a doc, or null if absent/invalid.
 * @param {string} docId
 * @returns {number | null}
 */
export function persistedReplicaId(docId: string): number | null;
/**
 * Resolve the replica id to use for a doc.
 *
 *  1. A read-only peer (readOnly) never writes, so it returns an unused random
 *     id without any server round-trip — `/docs/{id}/replica` requires write
 *     perm and would 403 a viewer.
 *  2. A persisted id (per-doc, localStorage) wins — stable across reloads.
 *  3. A brand-new doc (isNewDoc) uses 1: the client minted the uuid, so it's
 *     the only writer and 1 is collision-free — no server round-trip, works
 *     offline.
 *  4. Otherwise ask the server to allocate a fresh id.
 *
 * @param {{
 *   docId: string,
 *   wsUrl: string,
 *   getToken: () => Promise<string>,
 *   isNewDoc?: boolean,
 *   readOnly?: boolean,
 * }} opts
 * @returns {Promise<number>}
 */
export function resolveReplicaId({ docId, wsUrl, getToken, isNewDoc, readOnly }: {
    docId: string;
    wsUrl: string;
    getToken: () => Promise<string>;
    isNewDoc?: boolean;
    readOnly?: boolean;
}): Promise<number>;
