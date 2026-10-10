// @ts-check
//
// Comments on top of a Rogue CRDT doc. A comment is anchored to a span of CRDT
// node ids ("r:s" strings) — stable across edits — and surfaced as a live DOM
// range by mapping ids → vis indices → DOM positions through the node's
// annotation surface (`crdt` + `rope`). Data is REST (this module); real-time
// invalidation arrives from the sync client's `comment_changed` ping, which the
// consumer forwards to `handleRemoteChange`.
//
// The CRDT ids are opaque strings here — the server stores them verbatim, and
// this module never interprets their structure.

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
export function endOfDocPos(rope, visLen) {
  const last = visLen > 0 ? rope.getAtVisIx(visLen - 1) : null
  if (!last) return null
  if (last.node.kind === 'text') {
    const t = /** @type {Text} */ (last.node.domNode)
    return { node: t, offset: t.data.length }
  }
  const el = /** @type {Element} */ (last.node.domNode)
  const parent = el.parentNode
  if (!parent) return null
  return {
    node: parent,
    offset: Array.from(parent.childNodes).indexOf(el) + 1,
  }
}

/** Resolve a node-id anchor to a live DOM range, or null if the anchor is stale
 *  (an endpoint was deleted) or the doc is empty.
 *  @param {CrdtSurface} crdt @param {RopeSurface} rope
 *  @param {string} startId @param {string} endId
 *  @returns {DomRange | null} */
export function resolveAnchor(crdt, rope, startId, endId) {
  const s = crdt.visIxOf(startId)
  const e = crdt.visIxOf(endId)
  if (s === null || e === null || s > e) return null
  const start = rope.visIxToDomPos(s)
  if (!start) return null
  const end = rope.visIxToDomPos(e + 1) ?? endOfDocPos(rope, crdt.visLen())
  if (!end) return null
  return {
    startNode: start.node,
    startOffset: start.offset,
    endNode: end.node,
    endOffset: end.offset,
  }
}

/** Capture a DOM range as a node-id anchor (inclusive start/end char ids), or
 *  null for an empty/collapsed range.
 *  @param {CrdtSurface} crdt @param {RopeSurface} rope
 *  @param {DomRange} range
 *  @returns {{ start_id: string, end_id: string } | null} */
export function anchorForRange(crdt, rope, range) {
  const startIx = rope.domPosToVisIx(range.startNode, range.startOffset)
  const endIx = rope.domPosToVisIx(range.endNode, range.endOffset)
  if (startIx === null || endIx === null) return null
  const endCharIx = endIx - 1
  if (startIx > endCharIx) return null
  const startId = crdt.idAtVisIx(startIx)
  const endId = crdt.idAtVisIx(endCharIx)
  if (!startId || !endId) return null
  return { start_id: startId, end_id: endId }
}

/**
 * @param {CommentsOptions} options
 * @returns {Comments}
 */
export function createComments({ crdt, rope, baseUrl, fetchFn, rerender, onError, getSelectionRange }) {
  /** @type {CommentsFetcher} */
  const fetchImpl = fetchFn ?? ((input, init) => globalThis.fetch(input, init))

  /** @type {Comment[]} */
  let comments = []
  let destroyed = false

  /** @param {string} path @param {RequestInit} [init]
   *  @returns {Promise<any>} */
  async function request(path, init) {
    const res = await fetchImpl(baseUrl + path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
    if (!res.ok) throw new Error(`comments request failed: ${res.status} ${path}`)
    if (res.status === 204) return null
    return res.json()
  }

  /** @param {Comment} c @returns {ResolvedThread} */
  function resolve(c) {
    return { ...c, range: resolveAnchor(crdt, rope, c.start_id, c.end_id) }
  }

  /** @returns {ResolvedThread[]} */
  function resolved() {
    return comments.map(resolve)
  }

  function emit() {
    if (destroyed) return
    rerender?.(resolved())
  }

  /** Fetch the full thread list and re-emit.
   *  @returns {Promise<ResolvedThread[]>} */
  async function load() {
    comments = (await request('')) ?? []
    const out = resolved()
    emit()
    return out
  }

  /** @param {() => Promise<any>} fn */
  async function mutate(fn) {
    try {
      await fn()
      await load()
    } catch (err) {
      onError?.(/** @type {Error} */ (err))
      throw err
    }
  }

  return {
    load,

    threads: () => resolved(),

    create: (message) => {
      const range = getSelectionRange?.()
      if (!range) return Promise.reject(new Error('no text selected'))
      const anchor = anchorForRange(crdt, rope, range)
      if (!anchor) return Promise.reject(new Error('empty selection cannot be anchored'))
      return mutate(() =>
        request('', {
          method: 'POST',
          body: JSON.stringify({ ...anchor, message }),
        }),
      )
    },

    reply: (commentId, message) =>
      mutate(() =>
        request(`/${commentId}/replies`, {
          method: 'POST',
          body: JSON.stringify({ message }),
        }),
      ),

    update: (commentId, patch) =>
      mutate(() =>
        request(`/${commentId}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        }),
      ),

    remove: (commentId) =>
      mutate(() =>
        request(`/${commentId}`, { method: 'DELETE' }),
      ),

    /** Re-resolve anchors against the (already rebuilt) rope after a document
     *  edit. The `range` is the affected vis-index span — unused in v1, which
     *  re-resolves every thread (comment counts are small). */
    handleDocumentChange: (_range) => {
      emit()
    },

    /** Refetch the thread list (called from the `comment_changed` WS ping). */
    handleRemoteChange: () => load(),

    destroy: () => {
      destroyed = true
    },
  }
}
